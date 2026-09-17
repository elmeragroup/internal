/**
 * Runs one case with the GitHub environment absent, restoring the previous
 * values afterwards. Every case that constructs or imports release operations
 * needs the credentials gone, so the handling lives here once.
 *
 * @param run - The case body to run without GitHub credentials.
 */
export async function withMissingGitHubCredentials(run: () => Promise<void>): Promise<void> {
  const previous = {
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GH_TOKEN: process.env.GH_TOKEN,
  };
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GH_TOKEN;
  try {
    await run();
  } finally {
    if (previous.GITHUB_REPOSITORY === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previous.GITHUB_REPOSITORY;
    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.GH_TOKEN;
  }
}
