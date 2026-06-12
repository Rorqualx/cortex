// Legacy skills config migrations for the retired Skill Workshop block.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const SKILLS_WORKSHOP_RULE: LegacyConfigRule = {
  path: ["skills", "workshop"],
  message:
    'skills.workshop was retired with the Skill Workshop; approvalPolicy moved to skills.forge. Run "openclaw doctor --fix".',
  match: (value) => getRecord(value) !== null,
  requireSourceLiteral: true,
};

/** Legacy config migration specs for skills runtime config. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "skills.workshop->skills.forge",
    describe: "Move skills.workshop.approvalPolicy to skills.forge and drop retired workshop keys",
    legacyRules: [SKILLS_WORKSHOP_RULE],
    apply: (raw, changes) => {
      const skills = getRecord(raw.skills);
      const workshop = skills ? getRecord(skills.workshop) : null;
      if (!skills || !workshop) {
        return;
      }
      const approvalPolicy =
        workshop.approvalPolicy === "auto" || workshop.approvalPolicy === "pending"
          ? workshop.approvalPolicy
          : undefined;
      const forge = getRecord(skills.forge);
      if (approvalPolicy && !forge?.approvalPolicy) {
        skills.forge = { ...(forge ?? {}), approvalPolicy };
        changes.push("Moved skills.workshop.approvalPolicy → skills.forge.approvalPolicy.");
      }
      delete skills.workshop;
      changes.push(
        "Removed retired skills.workshop config (Skill Workshop was replaced by Skill Forge).",
      );
    },
  }),
];
