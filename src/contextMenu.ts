export function suppressContextMenu(event: Pick<Event, "preventDefault">): void {
  event.preventDefault();
}
