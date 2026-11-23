export async function refreshConditionsRows({
  html,
  buildRows,
  captureScroll = () => {},
  restoreScroll = () => {},
  isCurrent = () => true,
  beforeReplace = () => {}
}) {
  captureScroll();
  const rowsHtml = await buildRows();
  if (!isCurrent()) return null;
  beforeReplace();
  html.find(".conditions-rows").html(rowsHtml);
  restoreScroll();
  return rowsHtml;
}
