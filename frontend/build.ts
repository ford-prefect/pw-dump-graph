// Build identity of this frontend, baked in at build time (see vite.config.ts).
export const FRONTEND_VERSION: string = __PWG_VERSION__;
export const FRONTEND_COMMIT: string = __PWG_COMMIT__;
/** e.g. "0.2.0 (abc1234)" */
export const frontendBuild = `${FRONTEND_VERSION} (${FRONTEND_COMMIT})`;
export const REPO_URL: string = __PWG_REPO__;
