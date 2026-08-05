export async function refreshConditionsRows({
  html,
  buildRows,
  captureScroll = () => {},
  restoreScroll = () => {}
}) {
  captureScroll();
  const rowsHtml = await buildRows();
  html.find(".conditions-rows").html(rowsHtml);
  restoreScroll();
  return rowsHtml;
}
