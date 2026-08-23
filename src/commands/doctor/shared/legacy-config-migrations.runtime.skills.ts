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
    'skills.workshop was retired with the Skill Workshop; its settings moved to skills.forge. Run "openclaw doctor --fix".',
  match: (value) => getRecord(value) !== null,
  requireSourceLiteral: true,
};

/** Legacy config migration specs for skills runtime config. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "skills.workshop->skills.forge",
    describe: "Move skills.workshop settings to skills.forge and drop the retired workshop block",
    legacyRules: [SKILLS_WORKSHOP_RULE],
    apply: (raw, changes) => {
      const skills = getRecord(raw.skills);
      const workshop = skills ? getRecord(skills.workshop) : null;
      if (!skills || !workshop) {
        return;
      }
      // Carry every operator-set workshop field onto forge (only when forge has not already set
      // it) so an upgrade preserves prior behavior; the runtime reads only skills.forge now.
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
      const workshopMode = getRecord(workshop.autonomous)?.mode;
      if (
        (workshopMode === "off" || workshopMode === "propose" || workshopMode === "auto") &&
        getRecord(forge.autonomous)?.mode === undefined
      ) {
        forge.autonomous = { ...(getRecord(forge.autonomous) ?? {}), mode: workshopMode };
        moved = true;
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
  }),
];
