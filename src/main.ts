import { mount } from "svelte";
import App from "./App.svelte";
import PanelApp from "./lib/components/tree/PanelApp.svelte";
import "./styles/app.css";

const target = document.getElementById("app");
if (!target) throw new Error("#app element not found.");

/**
 * A detached key/value window loads this same page with `?panel=…`, and mounts
 * the table alone instead of the whole app.
 *
 * Routing on the URL rather than on a command keeps the decision synchronous:
 * the window knows what it is before its first paint, so a panel never flashes
 * the tab strip on the way to becoming a panel.
 */
const params = new URLSearchParams(location.search);
const docId = Number(params.get("doc"));
const nodeId = Number(params.get("node"));
const isPanel = params.has("panel") && Number.isFinite(docId) && Number.isFinite(nodeId);

export default isPanel
  ? mount(PanelApp, { target, props: { docId, nodeId } })
  : mount(App, { target });
