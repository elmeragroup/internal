/**
 * Environment variables that let a process act as the publish job: the GitHub tokens the engine
 * uses, and the OIDC request pair that npm exchanges for a publish token.
 */
const RELEASE_CREDENTIAL_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
] as const;

/**
 * Copies an environment without the release credentials, for child commands that install or run
 * dependency code during packing.
 *
 * @param env - The environment to copy. It is not modified.
 * @returns A new environment with every other variable kept.
 */
export function withoutReleaseCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of RELEASE_CREDENTIAL_ENV) Reflect.deleteProperty(copy, name);
  return copy;
}
