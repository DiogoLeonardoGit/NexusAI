/** Change only the labels represented by the source and destination columns. */
export function moveTaskLabels(task, sourceTag, destinationTag) {
  const tags = new Set(task.tags || []);
  if (sourceTag != null) tags.delete(sourceTag);
  if (destinationTag != null) tags.add(destinationTag);
  return [...tags];
}

/** Label views may overlap; the unassigned view excludes all configured columns. */
export function tasksForLabelView(tasks, view, views) {
  if (view.id === "done") return tasks.filter((task) => task.status === "done");
  if (view.tag != null) return tasks.filter((task) => task.tags?.includes(view.tag));
  const columnTags = new Set(views.map((item) => item.tag));
  return tasks.filter((task) => !task.tags?.some((tag) => columnTags.has(tag)));
}
