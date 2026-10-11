// Legacy skills config migrations for the retired Skill Workshop block.
import {
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { deleteRetiredPath } from "./legacy-config-record-shared.js";

// Fork: Skill Workshop settings live under skills.forge. Upstream's skills.workshop.* repairs
// are applied to the same settings at the fork's key so one config shape reaches the runtime.
const SKILLS_WORKSHOP_RULE: LegacyConfigRule = {
  path: ["skills", "workshop"],
  message:
    'skills.workshop was retired with the Skill Workshop; its settings moved to skills.forge. Run "openclaw doctor --fix".',
  match: (value) => getRecord(value) !== null,
  requireSourceLiteral: true,
};

const ENABLE_AUTO_HINT =
  "Run `openclaw config set skills.forge.autonomous.mode auto` to let agents save and update skills automatically (every change is announced and undoable).";

/** Legacy config migration specs for skills runtime config. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS: LegacyConfigMigrationSpec[] = [
  {
    id: "skills.workshop->skills.forge",
    legacyRules: [SKILLS_WORKSHOP_RULE],
    apply: (raw, changes) => {
      const skills = getRecord(raw.skills);
      const workshop = skills ? getRecord(skills.workshop) : null;
      if (!skills || !workshop) {
        return;
      }
      // Carry every operator-set workshop field onto forge (only when forge has not already set
      // it) so an upgrade preserves prior behavior; the runtime reads only skills.forge now.
      // Retired fields (maxPending, allowSymlinkTargetWrites, autonomous.enabled, mode "propose")
      // are carried as-is and repaired by the skills.forge migrations below.
      const forge = { ...(getRecord(skills.forge) ?? {}) };
      let moved = false;
      const carryForge = (key: string, value: unknown): void => {
        if (value !== undefined && forge[key] === undefined) {
          forge[key] = value;
          moved = true;
        }
      };
      const approvalPolicy =
        workshop.approvalPolicy === "auto" || workshop.approvalPolicy === "pending"
          ? workshop.approvalPolicy
          : undefined;
      carryForge("approvalPolicy", approvalPolicy);
      carryForge(
        "allowSymlinkTargetWrites",
        typeof workshop.allowSymlinkTargetWrites === "boolean"
          ? workshop.allowSymlinkTargetWrites
          : undefined,
      );
      carryForge(
        "maxPending",
        typeof workshop.maxPending === "number" ? workshop.maxPending : undefined,
      );
      carryForge(
        "maxSkillBytes",
        typeof workshop.maxSkillBytes === "number" ? workshop.maxSkillBytes : undefined,
      );
      const workshopAutonomous = getRecord(workshop.autonomous);
      const forgeAutonomous = getRecord(forge.autonomous);
      const workshopMode = workshopAutonomous?.mode;
      if (forgeAutonomous?.mode === undefined) {
        if (workshopMode === "off" || workshopMode === "propose" || workshopMode === "auto") {
          forge.autonomous = { ...forgeAutonomous, mode: workshopMode };
          moved = true;
        } else if (
          workshopAutonomous &&
          Object.hasOwn(workshopAutonomous, "enabled") &&
          forgeAutonomous?.enabled === undefined
        ) {
          forge.autonomous = { ...forgeAutonomous, enabled: workshopAutonomous.enabled };
          moved = true;
        }
      }
      if (moved) {
        skills.forge = forge;
        changes.push("Moved skills.workshop settings → skills.forge.");
      }
      delete skills.workshop;
      changes.push(
        "Removed retired skills.workshop config (Skill Workshop was replaced by Skill Forge).",
      );
    },
  },
  {
    id: "skills.forge.autonomous.enabled->mode",
    legacyRules: [
      {
        path: ["skills", "forge", "autonomous", "enabled"],
        message:
          'skills.forge.autonomous.enabled is retired; use skills.forge.autonomous.mode. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const autonomous = getRecord(getRecord(getRecord(raw.skills)?.forge)?.autonomous);
      if (!autonomous || !Object.hasOwn(autonomous, "enabled")) {
        return;
      }
      if (autonomous.mode === undefined) {
        autonomous.mode = "off";
        changes.push(
          autonomous.enabled === false
            ? 'Mapped skills.forge.autonomous.enabled to mode: "off".'
            : `Mapped skills.forge.autonomous.enabled to mode: "off" because Skill Workshop proposals were removed. ${ENABLE_AUTO_HINT}`,
        );
      } else {
        changes.push(
          "Removed skills.forge.autonomous.enabled because autonomous.mode is already set.",
        );
      }
      delete autonomous.enabled;
    },
  },
  {
    id: "skills.forge.autonomous.mode-propose->off",
    legacyRules: [
      {
        path: ["skills", "forge", "autonomous", "mode"],
        match: (value) => value === "propose",
        message:
          'skills.forge.autonomous.mode "propose" was removed with Skill Workshop proposals; use "off" or "auto". Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const autonomous = getRecord(getRecord(getRecord(raw.skills)?.forge)?.autonomous);
      if (autonomous?.mode !== "propose") {
        return;
      }
      autonomous.mode = "off";
      changes.push(
        `Skill Workshop proposals were removed; set skills.forge.autonomous.mode to "off" (was "propose"). ${ENABLE_AUTO_HINT}`,
      );
    },
  },
  {
    // skills.forge.approvalPolicy is NOT retired here: Skill Forge promote/retire approval
    // (src/skill-forge/approval-policy.ts) still reads it.
    id: "skills.forge.maxPending-retired",
    legacyRules: [
      {
        path: ["skills", "forge", "maxPending"],
        message:
          'skills.forge.maxPending was removed with Skill Workshop proposals. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      if (deleteRetiredPath(raw, ["skills", "forge", "maxPending"])) {
        changes.push("Removed skills.forge.maxPending; Skill Workshop proposals were removed.");
      }
    },
  },
  {
    id: "skills.forge.allowSymlinkTargetWrites-retired",
    legacyRules: [
      {
        path: ["skills", "forge", "allowSymlinkTargetWrites"],
        message:
          'skills.forge.allowSymlinkTargetWrites is retired; Skill Workshop writes only inside its own directory. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      if (deleteRetiredPath(raw, ["skills", "forge", "allowSymlinkTargetWrites"])) {
        changes.push(
          "Removed retired skills.forge.allowSymlinkTargetWrites; Skill Workshop writes only inside its own directory.",
        );
      }
    },
  },
];
