export async function refreshConditionsRows({
  html,
  buildRows,
  captureScroll = () => {},
  restoreScroll = () => {},
  isCurrent = () => true
}) {
  captureScroll();
  const rowsHtml = await buildRows();
  if (!isCurrent()) return null;
  html.find(".conditions-rows").html(rowsHtml);
  restoreScroll();
  return rowsHtml;
}
