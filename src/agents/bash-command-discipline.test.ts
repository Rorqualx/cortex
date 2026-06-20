import { describe, expect, it } from "vitest";
import { checkBashCommandDiscipline } from "./bash-command-discipline.js";

const ruleOf = (command: string, background = false) =>
  checkBashCommandDiscipline({ command, background })?.rule ?? null;

describe("checkBashCommandDiscipline", () => {
  describe("ast-grep", () => {
    it("blocks recursive / codebase grep and rg", () => {
      expect(ruleOf("grep -rn foo src/")).toBe("ast-grep");
      expect(ruleOf("grep -R foo .")).toBe("ast-grep");
      expect(ruleOf("rg foo")).toBe("ast-grep");
      expect(ruleOf("grep foo src/")).toBe("ast-grep");
    });
    it("allows single-file, piped, and text/log greps", () => {
      expect(ruleOf("grep -n foo a.ts")).toBeNull();
      expect(ruleOf("cat x.txt | grep foo")).toBeNull();
      expect(ruleOf("grep foo /var/log/syslog")).toBeNull();
      expect(ruleOf("grep error package.json")).toBeNull();
    });
  });

  describe("background", () => {
    it("blocks foreground long-runners and large sleeps", () => {
      expect(ruleOf("npm run dev")).toBe("background");
      expect(ruleOf("vite")).toBe("background");
      expect(ruleOf("tail -f app.log")).toBe("background");
      expect(ruleOf("sleep 30")).toBe("background");
    });
    it("allows when backgrounded, and non-long commands", () => {
      expect(ruleOf("npm run dev", true)).toBeNull();
      expect(ruleOf("vite build")).toBeNull();
      expect(ruleOf("vitest run")).toBeNull();
      expect(ruleOf("sleep 2")).toBeNull();
    });
  });

  describe("prefer-read", () => {
    it("blocks bare file reads via cat/head/tail/sed", () => {
      expect(ruleOf("cat src/index.ts")).toBe("prefer-read");
      expect(ruleOf("head -20 a.ts")).toBe("prefer-read");
      expect(ruleOf("sed -n '1,5p' a.ts")).toBe("prefer-read");
    });
    it("allows pipelines, redirects, heredocs, and tail -f (background's job)", () => {
      expect(ruleOf("cat a.ts | grep x")).toBeNull();
      expect(ruleOf("cat > out.txt")).toBeNull();
      expect(ruleOf("sed -i 's/a/b/' a.ts")).toBeNull();
      // tail -f is handled by the background rule, not prefer-read
      expect(ruleOf("tail -f log")).toBe("background");
    });
  });

  describe("git", () => {
    it("blocks force-push, reset --hard, clean -fd", () => {
      expect(ruleOf("git push --force")).toBe("git");
      expect(ruleOf("git push --force-with-lease origin x")).toBe("git");
      expect(ruleOf("git reset --hard HEAD~1")).toBe("git");
      expect(ruleOf("git clean -fd")).toBe("git");
    });
    it("allows ordinary git", () => {
      expect(ruleOf("git status")).toBeNull();
      expect(ruleOf("git push origin feature")).toBeNull();
      expect(ruleOf('git commit -m "fix: x"')).toBeNull();
      expect(ruleOf("git reset --soft HEAD~1")).toBeNull();
    });
  });

  describe("OpenClaw command vocabulary — no false positives", () => {
    it("allows the mandated test/build/type commands (filename substrings must not match)", () => {
      expect(ruleOf("node scripts/run-vitest.mjs src/x.test.ts")).toBeNull();
      expect(ruleOf("pnpm test src/agents/foo.test.ts")).toBeNull();
      expect(ruleOf("pnpm build")).toBeNull();
      expect(ruleOf("node scripts/run-tsgo.mjs -p tsconfig.core.json")).toBeNull();
    });
    it("never blocks ast-grep — the tool it promotes — even with serve()/watch in the pattern", () => {
      expect(ruleOf("ast-grep --pattern 'serve()' src/")).toBeNull();
      expect(ruleOf("ast-grep -p 'function $N($$$) { $$$ }' src/")).toBeNull();
    });
    it("does not treat a search term as a process launch", () => {
      expect(ruleOf("grep -n watch src/x.ts")).toBeNull();
    });
    it("allows reading logs/config via cat/tail (only source reads are redirected)", () => {
      expect(ruleOf("cat package.json")).toBeNull();
      expect(ruleOf("tail -n 50 build.log")).toBeNull();
      expect(ruleOf("cat .env")).toBeNull();
    });
    it("still backgrounds real watchers/dev servers", () => {
      expect(ruleOf("pnpm dev")).toBe("background");
      expect(ruleOf("tsc --watch")).toBe("background");
      expect(ruleOf("nodemon app.js")).toBe("background");
    });
  });

  describe("config gating", () => {
    it("disables a single rule when set to false", () => {
      const config = { astGrep: false };
      expect(checkBashCommandDiscipline({ command: "grep -rn foo src/", config })).toBeNull();
      // other rules still active
      expect(checkBashCommandDiscipline({ command: "git push --force", config })?.rule).toBe("git");
    });
    it("disables the whole guard when enabled:false", () => {
      const config = { enabled: false };
      expect(checkBashCommandDiscipline({ command: "git push --force", config })).toBeNull();
      expect(checkBashCommandDiscipline({ command: "grep -rn foo src/", config })).toBeNull();
    });
    it("empty command is always allowed", () => {
      expect(checkBashCommandDiscipline({ command: "   " })).toBeNull();
    });
  });
});
