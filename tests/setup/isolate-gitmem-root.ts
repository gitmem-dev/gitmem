/**
 * GIT-92 / GIT-91: assert the suite cannot reach the developer's real store.
 *
 * The isolation itself is in vitest.config.ts, which hands every worker a
 * throwaway GITMEM_HOME. HOME cannot be used: vitest runs on pool "threads",
 * where process.env is a JS-level copy that never reaches native getenv(), so
 * os.homedir() is unaffected by anything set from inside a worker.
 *
 * Why this matters: tests call setCurrentSession() with literal ids and those
 * writes follow getGitmemDir(). That used to land in <repo>/.gitmem, which was
 * already wrong — the suite left directories named original-session,
 * test-session-2/3 and test-session-clean in the developer's tree. GIT-91
 * removed the cwd walk-up, so the same writes now resolve ~/.gitmem: real
 * sessions, real threads, and on the free tier every learning ever captured.
 * The pollution did not appear with that change; it moved somewhere far worse.
 *
 * A run that can still see the real store is a broken harness, not a warning to
 * scroll past — so this throws rather than logs.
 */

import * as os from "os";
import * as path from "path";
import { getHomeGitmemDir } from "../../src/services/gitmem-dir.js";

const resolved = path.resolve(getHomeGitmemDir());
const tmp = path.resolve(os.tmpdir());

if (!resolved.startsWith(tmp)) {
  throw new Error(
    `[test-setup] the developer-scoped root resolves to ${resolved}, outside ${tmp}. ` +
    `The suite writes session state through getGitmemDir() and would touch the real ` +
    `store. Refusing to run — check the env block in vitest.config.ts.`
  );
}
