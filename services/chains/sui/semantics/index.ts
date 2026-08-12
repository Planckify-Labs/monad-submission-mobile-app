/**
 * Registration point for Sui PTB semantic passes.
 *
 * Importing this module docks every built-in pass. `SuiPtbDecoderInspector`
 * imports it for that side effect, so a new standard becomes visible on
 * the approval sheet by adding a file here and one `register` line —
 * nothing else in the bridge changes.
 */

import { registerPtbSemanticPass } from "../ptbSemantics";
import { KioskSemanticPass } from "./kioskPass";
import { PackageSemanticPass } from "./packagePass";

registerPtbSemanticPass(KioskSemanticPass);
registerPtbSemanticPass(PackageSemanticPass);

export { KioskSemanticPass, PackageSemanticPass };
