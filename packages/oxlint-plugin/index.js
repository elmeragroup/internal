import { eslintCompatPlugin } from "@oxlint/plugins";

import enforceVariantStandard from "./rules/enforce-variant-standard.js";
import facadeReexportGrammar from "./rules/facade-reexport-grammar.js";
import noFieldPartJsx from "./rules/no-field-part-jsx.js";
import noHardcodedDensityMetrics from "./rules/no-hardcoded-density-metrics.js";
import noInternalDynamicImport from "./rules/no-internal-dynamic-import.js";
import noLocalFocusRing from "./rules/no-local-focus-ring.js";
import noPrimitiveColors from "./rules/no-primitive-colors.js";
import noRacOutsideQuarantine from "./rules/no-rac-outside-quarantine.js";
import noRawClassMap from "./rules/no-raw-class-map.js";
import noTailwindDarkVariant from "./rules/no-tailwind-dark-variant.js";
import requireIconButtonLabel from "./rules/require-icon-button-label.js";
import restrictBrowserHelperCopy from "./rules/restrict-browser-helper-copy.js";
import restrictFocusRingCall from "./rules/restrict-focus-ring-call.js";
import restrictPackageRootFromScript from "./rules/restrict-package-root-from-script.js";
import restrictProcessEnv from "./rules/restrict-process-env.js";

export default eslintCompatPlugin({
  meta: {
    name: "elmera",
  },
  rules: {
    "enforce-variant-standard": enforceVariantStandard,
    "facade-reexport-grammar": facadeReexportGrammar,
    "no-field-part-jsx": noFieldPartJsx,
    "no-hardcoded-density-metrics": noHardcodedDensityMetrics,
    "no-internal-dynamic-import": noInternalDynamicImport,
    "no-local-focus-ring": noLocalFocusRing,
    "no-primitive-colors": noPrimitiveColors,
    "no-rac-outside-quarantine": noRacOutsideQuarantine,
    "no-raw-class-map": noRawClassMap,
    "no-tailwind-dark-variant": noTailwindDarkVariant,
    "require-icon-button-label": requireIconButtonLabel,
    "restrict-browser-helper-copy": restrictBrowserHelperCopy,
    "restrict-focus-ring-call": restrictFocusRingCall,
    "restrict-package-root-from-script": restrictPackageRootFromScript,
    "restrict-process-env": restrictProcessEnv,
  },
});
