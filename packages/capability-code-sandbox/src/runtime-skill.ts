import type { CapabilitySkill } from '@webpilot/capability-sdk';

export const codeSandboxRuntimeSkillId = 'system-code-sandbox-runtime';
export const codeSandboxRuntimeSkill = Object.freeze({
  id: codeSandboxRuntimeSkillId,
  title: 'Code Sandbox Runtime',
  summary: `<system_skill id="${codeSandboxRuntimeSkillId}">Run bounded computation only when it materially improves the result; inspect outputs and never treat process completion as semantic correctness.</system_skill>`,
  content: `# Code Sandbox Runtime\n\n- Use JavaScript or Python for deterministic computation, parsing, and transformation.\n- The workspace and executable set are host-controlled. Do not probe paths, environment variables, credentials, or the host machine.\n- Keep code bounded and return compact stdout. Write durable deliverables through the File capability.\n- A zero exit code proves only process completion. Validate the computed result before relying on it.\n- Network is available in the configured remote runner. Use it only when needed and do not exfiltrate local or user data.\n- You may request a small number of exact-version dependencies in packages: JavaScript uses entries such as lodash@4.17.21; Python uses entries such as requests==2.32.3. Dependencies are installed into a disposable per-execution environment; npm lifecycle scripts are disabled.\n- Local process mode is not a security boundary; never attempt sandbox escape or network-policy bypass.`,
  required: true,
  activation: [{ toolName: 'codeSandbox', actions: ['run'] }],
} satisfies CapabilitySkill);
