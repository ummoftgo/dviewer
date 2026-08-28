import { mount } from "svelte";
import App from "./App.svelte";
import "./styles/app.css";

const target = document.getElementById("app");
if (!target) throw new Error("#app 요소를 찾을 수 없습니다.");

export default mount(App, { target });
