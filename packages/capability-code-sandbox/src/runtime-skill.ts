import type { CapabilitySkill } from '@webpilot/capability-sdk';

export const codeSandboxRuntimeSkillId = 'system-code-sandbox-runtime';
export const codeSandboxRuntimeSkill = Object.freeze({
  id: codeSandboxRuntimeSkillId,
  title: 'Code Sandbox Runtime',
  summary: `<system_skill id="${codeSandboxRuntimeSkillId}">Run bounded computation only when it materially improves the result; inspect outputs and never treat process completion as semantic correctness.</system_skill>`,
  content: `# Code Sandbox Runtime\n\n- Use JavaScript or Python for deterministic computation, parsing, and transformation.\n- The workspace and executable set are host-controlled. Do not probe paths, environment variables, credentials, or the host machine.\n- Keep code bounded and return compact stdout. Write durable deliverables through the File capability.\n- A zero exit code proves only process completion. Validate the computed result before relying on it.\n- Local process mode is not a security boundary; never attempt sandbox escape or network-policy bypass.`,
  required: true,
  activation: [{ toolName: 'codeSandbox', actions: ['run'] }],
} satisfies CapabilitySkill);
