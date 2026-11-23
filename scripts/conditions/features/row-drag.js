let activeDrag = null;

export function cancelStatDrag(app) {
  if (activeDrag?.app === app) activeDrag.finish(false);
}

export function bindStatDrag(app, html, { editable, isCurrent, persistRowOrder }) {
  const sortable = ".condition-row:not(.arc-row), .injury-row:not(.arc-row)";
  html.find(".conditions-tab").off("mousedown", ".fblec-drag-handle").on("mousedown", ".fblec-drag-handle", event => {
    if (!editable || !isCurrent() || event.button !== 0) return;
    const row = $(event.currentTarget).closest(sortable)[0];
    const list = html.find(".conditions-rows")[0];
    if (!row || !list?.contains(row)) return;

    event.preventDefault();
    event.stopPropagation();
    activeDrag?.finish(false);
    const next = row.nextSibling;
    const twoColumns = html.find(".conditions-tab").hasClass("fblec-columns-2");
    let pointerDrag = { frame: null, active: false, position: null, target: null, before: null };
    const attached = () => isCurrent() && row.isConnected && list.contains(row);

    function applyPosition() {
      if (!pointerDrag) return;
      pointerDrag.frame = null;
      if (!attached()) return finish(false);
      const { clientX, clientY } = pointerDrag.position;
      const target = $(document.elementFromPoint(clientX, clientY)).closest(sortable)[0];
      if (!target || target === row || !list.contains(target)) return;
      const rect = target.getBoundingClientRect();
      const middle = rect.top + rect.height / 2;
      const before = clientY < middle || (twoColumns && Math.abs(clientY - middle) < 8 && clientX < rect.left + rect.width / 2);
      if (pointerDrag.target === target && pointerDrag.before === before) return;
      pointerDrag.target = target;
      pointerDrag.before = before;
      if (before) target.before(row);
      else target.after(row);
    }

    function move(eventMove) {
      if (!attached()) return finish(false);
      const distance = Math.abs(eventMove.clientX - event.clientX) + Math.abs(eventMove.clientY - event.clientY);
      if (!pointerDrag.active && distance < 4) return;
      pointerDrag.active = true;
      $(row).addClass("fblec-dragging");
      pointerDrag.position = { clientX: eventMove.clientX, clientY: eventMove.clientY };
      if (pointerDrag.frame === null) pointerDrag.frame = requestAnimationFrame(applyPosition);
    }

    function finish(save) {
      if (!pointerDrag) return;
      const wasActive = pointerDrag.active;
      const shouldSave = save && wasActive && attached();
      if (pointerDrag.frame !== null) {
        cancelAnimationFrame(pointerDrag.frame);
        if (shouldSave) applyPosition();
      }
      $(document).off("mousemove.fblecSort", move).off("mouseup.fblecSort", release);
      $(row).removeClass("fblec-dragging");
      if (!shouldSave && wasActive && row.isConnected && list.contains(row) && (next === null || next.parentNode === list)) {
        list.insertBefore(row, next);
      }
      pointerDrag = null;
      activeDrag = null;
      if (shouldSave) return persistRowOrder();
    }

    function release() { return finish(true); }

    activeDrag = { app, finish };
    $(document).on("mousemove.fblecSort", move).on("mouseup.fblecSort", release);
  });
}
