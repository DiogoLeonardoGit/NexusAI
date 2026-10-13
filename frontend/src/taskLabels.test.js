import { describe, expect, it } from "vitest";
import { moveTaskLabels, tasksForLabelView } from "./taskLabels";

describe("label views", () => {
  it("moves between columns without losing unrelated labels", () => {
    const task = { tags: [1, 2, 3] };
    expect(moveTaskLabels(task, 1, 4)).toEqual([2, 3, 4]);
    expect(task.tags).toEqual([1, 2, 3]);
    expect(moveTaskLabels(task, 1, 2)).toEqual([2, 3]);
    expect(moveTaskLabels(task, 1, null)).toEqual([2, 3]);
  });
  it("shows multiple labels in multiple views and keeps other tasks visible", () => {
    const views = [{ id: 10, tag: 1 }, { id: 20, tag: 2 }];
    const tasks = [{ id: 1, tags: [1, 2], status: "todo" }, { id: 2, tags: [3], status: "done" }, { id: 3, tags: [], status: "todo" }];
    expect(tasksForLabelView(tasks, views[0], views).map((task) => task.id)).toEqual([1]);
    expect(tasksForLabelView(tasks, views[1], views).map((task) => task.id)).toEqual([1]);
    expect(tasksForLabelView(tasks, { tag: null }, views).map((task) => task.id)).toEqual([2, 3]);
    expect(tasksForLabelView(tasks, { id: "done" }, views).map((task) => task.id)).toEqual([2]);
  });
});
