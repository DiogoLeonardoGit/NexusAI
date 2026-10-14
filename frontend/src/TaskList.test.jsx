import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { TaskList } from "./App";
import GitLabSettings from "./GitLabSettings";
import { api } from "./api";

vi.mock("./api", () => ({ api: vi.fn(), apiText: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let element, root;
const task = { id: 1, title: "Preparar entrega", owner: "self", status: "todo", description: "Detalhes", tags: [1, 3], created_at: "2026-10-13T10:00:00Z", creation_source: "manual" };
const tags = [{ id: 1, name: "Em curso" }, { id: 2, name: "Revisão" }, { id: 3, name: "P1" }];
const sections = [{ id: 10, tag: 1, name: "Em curso", collapsed: false }, { id: 20, tag: 2, name: "Revisão", collapsed: false }];
const defaults = { tasks: [task], tags, sections, showSections: true, refresh: vi.fn(), onError: vi.fn() };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear(); api.mockReset(); api.mockResolvedValue({});
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(props = {}) { await act(async () => root.render(<TaskList {...defaults} {...props}/>)); }
async function click(text) {
  const button = [...element.querySelectorAll("button")].find((item) => item.textContent === text);
  expect(button).toBeTruthy(); await act(async () => button.click());
}
function dragEvent(type) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData: vi.fn() } }); return event;
}

describe("task interface", () => {
  it("opens creation only from the plus button and keeps existing filters", async () => {
    await render();
    expect(element.querySelector(".quick-task")).toBeNull();
    expect(element.querySelector(".filters").textContent).toContain("Minhas tarefas");
    expect(element.textContent).not.toContain("Prioridade");
    await act(async () => element.querySelector('[aria-label="Adicionar tarefa"]').click());
    expect(element.querySelector(".quick-task")).toBeTruthy();
    expect(element.querySelector(".task-filter-row .add-task-button")).toBeTruthy();
    await click("Cancelar"); expect(element.querySelector(".quick-task")).toBeNull();
  });
  it("moves cards between label columns while retaining priority labels", async () => {
    await render(); await click("Quadro");
    expect(element.querySelector(".task-board")).toBeTruthy();
    const source = element.querySelector(".task-board-card");
    expect(source.textContent).toBe(task.title);
    expect(source.querySelector(".task-description, .task-meta, .item-actions, .task-drag-handle, .check")).toBeNull();
    const destination = [...element.querySelectorAll(".task-section")].find((item) => item.querySelector("strong").textContent === "Revisão");
    await act(async () => source.dispatchEvent(dragEvent("dragstart")));
    await act(async () => destination.dispatchEvent(dragEvent("drop")));
    expect(api).toHaveBeenCalledWith("/tasks/1/", { method: "PATCH", body: JSON.stringify({ tags: [3, 2] }) });
  });
  it("completes a card dropped in the completed column", async () => {
    await render(); await click("Quadro");
    const source = element.querySelector(".task-board-card");
    const destination = [...element.querySelectorAll(".task-section")].find((item) => item.querySelector("strong").textContent === "Concluídas");
    await act(async () => source.dispatchEvent(dragEvent("dragstart")));
    await act(async () => destination.dispatchEvent(dragEvent("drop")));
    expect(api).toHaveBeenCalledWith("/tasks/1/complete/", { method: "POST" });
  });
  it("marks only imported tasks with GitLab and hides them using a local action", async () => {
    const imported = { ...task, creation_source: "gitlab", gitlab: { web_url: "https://gitlab.warpcom.com/project/-/issues/5", available_tag_ids: [1, 2, 3], pending: true, conflicts: {} } };
    await render(); expect(element.querySelector(".gitlab-origin")).toBeNull();
    await render({ tasks: [imported] });
    expect(element.querySelector(".gitlab-origin")).toBeTruthy();
    expect(element.textContent).toContain("Alterações locais pendentes");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click("Ocultar nesta app");
    expect(api).toHaveBeenCalledWith("/tasks/1/hide/", { method: "POST" });
  });
  it("preserves owner and completion filters", async () => {
    await render({ tasks: [task, { ...task, id: 2, title: "Concluída", status: "done" }, { ...task, id: 3, title: "Outro", owner: "other" }] });
    await click("Minhas tarefas");
    expect(element.querySelectorAll("[data-task-id]")).toHaveLength(1);
    await click("Concluídas");
    expect(element.querySelectorAll("[data-task-id]")).toHaveLength(1);
    expect(element.querySelector("[data-task-id]").textContent).toContain("Concluída");
  });
});

describe("GitLab settings", () => {
  it("shows a disabled, read-only connection and never starts synchronization on mount", async () => {
    api.mockResolvedValue({ base_url: "https://gitlab.warpcom.com", project_path: "serviceunit/django-apps/twinportal", enabled: false,
      read_only: true, has_token: false, pending: 0, conflicts: 0, hidden: 0, inactive: 0 });
    await act(async () => root.render(<GitLabSettings onError={vi.fn()} refresh={vi.fn()}/>));
    expect(element.textContent).toContain("Sincronização desativada");
    expect(element.textContent).toContain("Escritas remotas bloqueadas");
    expect([...element.querySelectorAll("button")].find((item) => item.textContent === "Sincronizar agora").disabled).toBe(true);
    expect(api.mock.calls.every(([path]) => path === "/gitlab/")).toBe(true);
  });

  it("mounts the full app and exposes the new controls through the existing tabs", async () => {
    localStorage.setItem("activeListeningEnabled", "false");
    const config = { base_url: "https://gitlab.warpcom.com", project_path: "serviceunit/django-apps/twinportal", enabled: false,
      read_only: true, has_token: false, pending: 0, conflicts: 0, hidden: 0, inactive: 0 };
    api.mockImplementation(async (path) => {
      if (path === "/gitlab/") return config;
      if (path === "/health/") return { model: "Local", ollama: false };
      if (path === "/tasks/") return [task];
      if (path === "/tags/") return tags;
      return [];
    });
    await act(async () => root.render(<App/>));
    await click("Tarefas");
    expect(element.querySelector(".quick-task")).toBeNull();
    expect(element.querySelector('[aria-label="Adicionar tarefa"]')).toBeTruthy();
    expect(element.textContent).toContain("Sincronização GitLab desativada");
    await click("Definições");
    expect(element.querySelector(".gitlab-settings")).toBeTruthy();
    expect(element.textContent).toContain("serviceunit/django-apps/twinportal");
    expect(api.mock.calls.some(([path]) => path === "/gitlab/sync/")).toBe(false);
  });
});
