// The real shadcn-vue components, for component tests that compile a page with stubbed imports:
// `require: (name) => ({ ...stubs })[name] ?? ui(name)`.
import GroupRow from "../../web/src/components/group/GroupRow.vue";
import Segmented from "../../web/src/components/group/Segmented.vue";
import SettingsGroup from "../../web/src/components/group/SettingsGroup.vue";
import SettingsSubpage from "../../web/src/components/SettingsSubpage.vue";
import * as alert from "../../web/src/components/ui/alert";
import * as alertDialog from "../../web/src/components/ui/alert-dialog";
import * as avatar from "../../web/src/components/ui/avatar";
import * as badge from "../../web/src/components/ui/badge";
import * as breadcrumb from "../../web/src/components/ui/breadcrumb";
import * as button from "../../web/src/components/ui/button";
import * as card from "../../web/src/components/ui/card";
import * as checkbox from "../../web/src/components/ui/checkbox";
import * as collapsible from "../../web/src/components/ui/collapsible";
import * as command from "../../web/src/components/ui/command";
import * as dialog from "../../web/src/components/ui/dialog";
import * as dropdownMenu from "../../web/src/components/ui/dropdown-menu";
import * as input from "../../web/src/components/ui/input";
import * as label from "../../web/src/components/ui/label";
import * as popover from "../../web/src/components/ui/popover";
import * as progress from "../../web/src/components/ui/progress";
import * as radioGroup from "../../web/src/components/ui/radio-group";
import * as select from "../../web/src/components/ui/select";
import * as separator from "../../web/src/components/ui/separator";
import * as sheet from "../../web/src/components/ui/sheet";
import * as skeleton from "../../web/src/components/ui/skeleton";
import * as slider from "../../web/src/components/ui/slider";
import * as switchModule from "../../web/src/components/ui/switch";
import * as table from "../../web/src/components/ui/table";
import * as tabs from "../../web/src/components/ui/tabs";
import * as textarea from "../../web/src/components/ui/textarea";
import * as toast from "../../web/src/components/ui/toast";
import * as toggleGroup from "../../web/src/components/ui/toggle-group";
import * as tooltip from "../../web/src/components/ui/tooltip";

const modules: Record<string, unknown> = {
  "radio-group": radioGroup,
  avatar,
  toast: toast,
  command: command,
  popover: popover,
  slider: slider,
  select: select,
  dialog: dialog,
  "toggle-group": toggleGroup,
  alert,
  "alert-dialog": alertDialog,
  badge,
  breadcrumb,
  button,
  card,
  checkbox,
  collapsible,
  "dropdown-menu": dropdownMenu,
  input,
  label,
  progress,
  separator,
  sheet,
  skeleton,
  switch: switchModule,
  table,
  tabs,
  textarea,
  tooltip,
};

const groups: Record<string, unknown> = { GroupRow, Segmented, SettingsGroup };

export function ui(name: string): unknown {
  const group = /(?:^|\/)group\/([A-Za-z]+)\.vue$/.exec(name);
  if (group) return { __esModule: true, default: groups[group[1]!] };
  // What a settings page opens: a dialog here, as no 设置 window hosts it in a test.
  if (/(?:^|\/)SettingsSubpage\.vue$/.test(name)) return { __esModule: true, default: SettingsSubpage };
  const match = /(?:^|\/)(?:components\/)?ui\/([a-z-]+)$/.exec(name);
  return match ? modules[match[1]!] : undefined;
}
