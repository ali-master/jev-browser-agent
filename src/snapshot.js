(() => {
  if (!document.body) return null;
  const roots = [document];
  // Open roots only; closed roots retain the browser's encapsulation boundary.
  for (let i = 0; i < roots.length && i < 100; i++)
    for (const e of roots[i].querySelectorAll("*"))
      if (e.shadowRoot && roots.length < 100) roots.push(e.shadowRoot);
  const query = (selector) =>
    roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  const hit = (x, y) => {
    let e = document.elementFromPoint(x, y),
      next;
    while ((next = e?.shadowRoot?.elementFromPoint(x, y)) && next !== e)
      e = next;
    return e;
  };
  const active = () => {
    let e = document.activeElement;
    while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
    return e;
  };
  for (const selector of window.__jevRemoveSelectors ?? []) {
    for (const element of query(selector)) {
      if (["HTML", "HEAD", "BODY"].includes(element.tagName)) continue;
      element.remove();
    }
  }
  const cache = (window.__jevFast ||= {
    ids: new WeakMap(),
    nodes: new Map(),
    next: 1,
  });
  cache.hit = hit;
  cache.active = active;
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e);
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const secret = (e) =>
    (window.__jevSecretFields ?? []).find((field) => field.label === name(e));
  cache.secretVersions ||= new WeakMap();
  const guardedValue = (e) => {
    if (!secret(e)) return e.value ?? null;
    const old = cache.secretVersions.get(e);
    if (!old || old.value !== e.value)
      cache.secretVersions.set(e, {
        value: e.value,
        version: (old?.version ?? 0) + 1,
      });
    return ["secret", cache.secretVersions.get(e).version];
  };
  const safe = (e) =>
    !["file", "hidden"].includes(e.type) &&
    (e.type !== "password" || secret(e));
  const visible = (e) => {
    for (let current = e; current; current = current.getRootNode().host)
      if (current.closest('[aria-hidden="true"],[inert]')) return false;
    return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return "";
    seen.add(e);
    const referenced = (e.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => name(e.getRootNode().getElementById?.(id), seen))
      .filter(Boolean)
      .join(" ");
    return (
      referenced ||
      e.getAttribute("aria-label") ||
      [...(e.labels || [])]
        .map((l) => name(l, seen))
        .filter(Boolean)
        .join(" ") ||
      (["button", "submit", "reset"].includes(e.type) ? e.value : "") ||
      e.getAttribute("alt") ||
      (e.tagName === "INPUT"
        ? ""
        : [...e.childNodes]
            .map((n) =>
              n.nodeType === 3
                ? n.textContent
                : n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true"
                  ? name(n, seen)
                  : "",
            )
            .join(" ")
            .trim()) ||
      e.getAttribute("title") ||
      e.getAttribute("placeholder") ||
      ""
    );
  };
  const roles = [
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemradio",
    "option",
    "gridcell",
    "combobox",
    "textbox",
    "searchbox",
    "spinbutton",
    "slider",
  ];
  const selector =
    "a[href],button,input,textarea,select,summary,label,[contenteditable],[onclick]," +
    roles.map((role) => '[role="' + role + '"]').join(",");
  const document_id = (cache.documentId ||= [
    ...crypto.getRandomValues(new Uint32Array(4)),
  ].join("-"));
  const popupSelector = 'dialog,[role="dialog"],[role="listbox"],[role="menu"]';
  const popups = query(popupSelector).filter(visible);
  cache.popupOwners ||= new Map();
  cache.popupDates ||= new Map();
  cache.committedDates ||= new WeakMap();
  for (const [root, owner] of cache.popupOwners) {
    const pending = cache.popupDates.get(root);
    if (popups.includes(root)) {
      const selected = [
        ...root.querySelectorAll('[role="gridcell"][aria-selected="true"]'),
      ].filter(visible);
      // shortcut: English calendar labels only; add locale parsing for localized calendars.
      const fullDate =
        selected.length === 1 &&
        name(selected[0]).match(
          /\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2},? \d{4}\b/,
        );
      if (pending && fullDate) pending.date = new Date(fullDate[0]);
    } else {
      const field = cache.nodes.get(Number(owner?.split(":").at(-1)));
      if (
        field?.isConnected &&
        pending?.date &&
        field.value !== pending.before
      ) {
        const date = pending.date,
          compact = (s) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
        const formats = [
          { month: "short", day: "numeric" },
          { weekday: "short", month: "short", day: "numeric" },
        ];
        // Retain a year only from an observed selected day, never from a short display alone.
        if (
          formats.some(
            (format) =>
              compact(date.toLocaleDateString("en-US", format)) ===
              compact(field.value),
          )
        )
          cache.committedDates.set(field, {
            display: field.value,
            date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
          });
      }
      cache.popupOwners.delete(root);
      cache.popupDates.delete(root);
    }
  }
  if (cache.pendingPopup) {
    const added = popups.filter(
      (root) => !cache.pendingPopup.before.includes(root),
    );
    for (const root of added) {
      cache.popupOwners.set(root, cache.pendingPopup.ref);
      cache.popupDates.set(root, { before: cache.pendingPopup.value });
    }
    if (added.length || performance.now() - cache.pendingPopup.at > 1500)
      cache.pendingPopup = null;
  }
  cache.beginPopup = (ref) => {
    const field = cache.nodes.get(Number(ref?.split(":").at(-1)));
    if (field) cache.committedDates.delete(field);
    cache.pendingPopup = {
      ref,
      value: field?.value,
      at: performance.now(),
      before: popups,
    };
  };
  const scopeSelector =
    'fieldset,form,[role="form"],dialog,[role="dialog"],article,li,tr,[role="row"]';
  const fieldScope = (e) => {
    const labels = [];
    let container = e.parentElement?.closest(scopeSelector);
    let nearby = e.parentElement;
    for (
      let depth = 0;
      !container && nearby && depth < 3;
      depth++, nearby = nearby.parentElement
    ) {
      const text = nearby.innerText?.trim() || "";
      if (text.length > name(e).length + 4 && text.length <= 600)
        container = nearby;
    }
    const context = container?.innerText?.trim().slice(0, 600) || "";
    for (
      let depth = 0;
      container && depth < 3;
      depth++, container = container.parentElement?.closest(scopeSelector)
    ) {
      const heading = container.querySelector(
        ':scope > legend,:scope > caption,:scope > [role="rowheader"],:scope > th,:scope > h1,:scope > h2,:scope > h3',
      );
      const label =
        container.hasAttribute("aria-label") ||
        container.hasAttribute("aria-labelledby")
          ? name(container)
          : name(heading) || container.getAttribute("name") || container.id;
      if (label) labels.unshift(label.trim().slice(0, 120));
    }
    return { scope: labels.join(" / ") || context.slice(0, 120), context };
  };
  const control = (e) =>
    e.tagName === "LABEL" && ["checkbox", "radio"].includes(e.control?.type)
      ? e.control
      : e;
  const customClickable = (e) =>
    e.hasAttribute("onclick") ||
    typeof e.onclick === "function" ||
    (getComputedStyle(e).cursor === "pointer" &&
      getComputedStyle(e.parentElement || document.body).cursor !== "pointer");
  const role = (e) => {
    if (control(e) !== e) return control(e).type;
    const explicit = e.getAttribute("role");
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === "BUTTON" || e.tagName === "SUMMARY") return "button";
    if (e.tagName === "A") return "link";
    if (e.tagName === "SELECT") return "combobox";
    if (e.tagName === "TEXTAREA" || e.isContentEditable) return "textbox";
    if (e.tagName === "INPUT") {
      if (["checkbox", "radio"].includes(e.type)) return e.type;
      if (["button", "submit", "reset", "image"].includes(e.type))
        return "button";
      if (e.type === "search") return "searchbox";
      if (e.type === "number") return "spinbutton";
      if (e.type === "range") return "slider";
      if (
        ["date", "time", "datetime-local", "month", "week", "color"].includes(
          e.type,
        )
      )
        return "textbox";
      if (
        ["text", "email", "url", "tel"].includes(e.type) ||
        (e.type === "password" && secret(e))
      )
        return "textbox";
    }
    return customClickable(e) ? "button" : null;
  };
  cache.pageKey = () => [
    performance.timeOrigin,
    location.href,
    scrollX,
    scrollY,
    innerWidth,
    innerHeight,
    query("input,textarea,select")
      .filter(safe)
      .map((e) => [
        identity(e),
        guardedValue(e),
        e.checked,
        e.selectedIndex,
        e.disabled,
        e.readOnly,
      ]),
  ];
  cache.guard = (e) => {
    if (!e?.isConnected || !visible(e)) return null;
    const c = control(e);
    const scope = e.closest(scopeSelector) || e.parentElement;
    return [
      identity(e),
      [
        identity(c),
        guardedValue(c),
        c.checked ?? null,
        c.matches(":disabled"),
        c.closest('[inert],[aria-disabled="true"]') !== null,
      ],
      role(e),
      name(e),
      guardedValue(e),
      e.checked ?? null,
      e.selectedIndex ?? null,
      e.readOnly ?? null,
      [e.type ?? null, e.min ?? null, e.max ?? null, e.step ?? null],
      e.matches(":disabled"),
      e.getAttribute("aria-disabled"),
      e.getAttribute("aria-expanded"),
      e.tagName === "SUMMARY" ? e.parentElement?.open : null,
      e.getAttribute("aria-checked"),
      e.getAttribute("aria-selected"),
      e.closest('[role="gridcell"]')?.getAttribute("aria-selected") ?? null,
      e.getAttribute("href"),
      e.scrollTop,
      e.scrollHeight,
      c.form ? identity(c.form) : null,
      scope?.innerText?.slice(0, 6000) || "",
      fieldScope(e),
      e.tagName === "SELECT"
        ? [...e.options].map((o) => [
            identity(o),
            o.value,
            o.label,
            o.disabled,
            Boolean(o.closest("optgroup[disabled]")),
          ])
        : null,
    ];
  };
  const actions = [];
  const candidates = new Set(query(selector));
  const extra = roots
    .flatMap((root) => [...root.querySelectorAll("*")])
    .slice(0, 5001);
  let candidate,
    inspected = 0;
  while (inspected < 5000 && (candidate = extra[inspected])) {
    inspected++;
    if (
      !candidates.has(candidate) &&
      !candidate.parentElement?.closest(selector) &&
      visible(candidate) &&
      customClickable(candidate)
    )
      candidates.add(candidate);
  }
  const discovery_limited = extra.length > 5000;
  for (const e of candidates) {
    const c = control(e);
    if (
      !safe(c) ||
      !visible(e) ||
      c.matches(":disabled") ||
      c.closest('[inert],[aria-disabled="true"]') ||
      e.closest('[aria-disabled="true"]')
    )
      continue;
    if (e.isContentEditable && e.parentElement?.isContentEditable) continue;
    if (c !== e && visible(c)) {
      const box = c.getBoundingClientRect();
      if (box.width >= 4 && box.height >= 4) continue;
    }
    const r = e.getBoundingClientRect(),
      x = r.x + r.width / 2,
      y = r.y + r.height / 2,
      rname = role(e);
    if (
      !rname ||
      r.width <= 0 ||
      r.height <= 0 ||
      x < 0 ||
      y < 0 ||
      x >= innerWidth ||
      y >= innerHeight
    )
      continue;
    if (!e.contains(hit(x, y))) continue;
    if (rname === "gridcell" && e.querySelector('button,[role="button"]'))
      continue;
    const base = {
      node: identity(e),
      ref: `${document_id}:${identity(c)}`,
      ...fieldScope(e),
      html_id: c.id,
      html_name: c.getAttribute("name") || "",
      role: rname,
      label: name(e) || rname,
      ...(secret(c) ? { secret_key: secret(c).key } : {}),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
    if (e.tagName === "A" && /^https?:/.test(e.href)) base.href = e.href;
    if (c.form) base.form_ref = `${document_id}:${identity(c.form)}`;
    if (e.tagName === "SUMMARY")
      base.expanded = String(e.parentElement?.open === true);
    if (
      (e.tagName === "A" && /^https?:/.test(e.href)) ||
      (e.type === "submit" && e.form)
    )
      base.native_navigation = true;
    const popup = [...cache.popupOwners.keys()].find((root) =>
      root.contains(e),
    );
    if (popup) base.popup_owner = cache.popupOwners.get(popup);
    if (
      e.tagName !== "SELECT" &&
      (rname === "combobox" ||
        (e.hasAttribute("aria-haspopup") &&
          e.getAttribute("aria-haspopup") !== "false"))
    )
      base.has_popup = true;
    if (e.tagName === "INPUT") {
      base.input_type = e.type;
      base.constraints = { min: e.min, max: e.max, step: e.step };
      const committed = cache.committedDates.get(e);
      if (committed?.display === e.value) base.value_date = committed.date;
    }
    const cell = e.closest('[role="gridcell"]');
    if (rname === "button" && cell) {
      base.role = "gridcell";
      base.selected = cell.getAttribute("aria-selected") || "false";
    }
    for (const key of ["checked", "selected", "expanded"]) {
      const value = e.getAttribute("aria-" + key);
      if (value !== null) base[key] = value;
    }
    if (["checkbox", "radio"].includes(c.type))
      base.checked = String(c.checked);
    if (e.tagName === "SELECT") {
      for (const o of e.options)
        if (!o.selected && !o.disabled && !o.closest("optgroup[disabled]"))
          actions.push({
            ...base,
            kind: "select",
            value: o.value,
            option_index: o.index,
            option_node: identity(o),
            current_value: [...e.selectedOptions]
              .map((o) => o.label)
              .join(", "),
            label: base.label + " → " + o.label,
          });
    } else {
      const editable =
        !e.readOnly &&
        e.getAttribute("aria-readonly") !== "true" &&
        (["textbox", "searchbox", "spinbutton"].includes(rname) ||
          (e.tagName === "INPUT" && e.type === "range") ||
          (rname === "combobox" && ["INPUT", "TEXTAREA"].includes(e.tagName)));
      const value =
        rname === "combobox" && !["INPUT", "TEXTAREA"].includes(c.tagName)
          ? e.innerText.trim()
          : secret(c)
            ? c.value
              ? "[redacted]"
              : ""
            : "value" in c
              ? String(c.value)
              : e.isContentEditable || rname === "combobox"
                ? e.innerText.trim()
                : "";
      actions.push({ ...base, kind: editable ? "fill" : "click", value });
      if (editable)
        actions.push({
          ...base,
          kind: "click",
          value,
          label: "Open " + base.label,
        });
    }
  }
  for (const e of extra.slice(0, 5000)) {
    if (
      !visible(e) ||
      !/(auto|scroll)/.test(getComputedStyle(e).overflowY) ||
      e.scrollHeight <= e.clientHeight + 2 ||
      ["HTML", "BODY", "TEXTAREA", "SELECT"].includes(e.tagName)
    )
      continue;
    const r = e.getBoundingClientRect(),
      x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    if (
      x < 0 ||
      y < 0 ||
      x >= innerWidth ||
      y >= innerHeight ||
      !e.contains(hit(x, y))
    )
      continue;
    for (const delta of [-560, 560]) {
      if (
        delta < 0
          ? e.scrollTop <= 0
          : e.scrollTop + e.clientHeight >= e.scrollHeight - 2
      )
        continue;
      actions.push({
        kind: "click",
        node: identity(e),
        ref: `${document_id}:${identity(e)}`,
        role: "scrollbar",
        label: `Scroll ${delta > 0 ? "down" : "up"} in ${name(e).slice(0, 80) || "panel"}`,
        scroll_delta: delta,
        value: String(e.scrollTop),
        scope: fieldScope(e).scope,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      });
    }
  }
  const editableForms = new Set(
    actions
      .filter((action) => action.kind === "fill" || action.kind === "select")
      .map((action) => cache.nodes.get(action.node)?.form)
      .filter(Boolean),
  );
  for (const action of actions) {
    const element = cache.nodes.get(action.node);
    if (
      action.kind === "click" &&
      element?.type === "submit" &&
      editableForms.has(element.form)
    )
      action.submits_form = true;
  }
  const readingUrl = location.href.split("#")[0];
  if (cache.readUrl !== readingUrl) {
    cache.readUrl = readingUrl;
    cache.readText = new Map();
  }
  // Retain only text actually seen that still exists unchanged in this document.
  for (const [node, value] of cache.readText) {
    if (
      !node.isConnected ||
      node.textContent.trim() !== value ||
      !visible(node.parentElement)
    )
      cache.readText.delete(node);
  }
  const words = [];
  const walkers = roots.map((root) =>
    document.createTreeWalker(
      root === document ? document.body : root,
      NodeFilter.SHOW_TEXT,
    ),
  );
  const range = document.createRange();
  let node,
    length = 0;
  for (const walker of walkers)
    while ((node = walker.nextNode()) && length < 6000) {
      const value = node.textContent.trim(),
        parent = node.parentElement;
      if (
        !value ||
        !parent ||
        parent.closest("script,style,noscript,template") ||
        !visible(parent)
      )
        continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < innerHeight &&
        r.right > 0 &&
        r.left < innerWidth &&
        (() => {
          const e = hit(
            Math.max(0, Math.min(innerWidth - 1, (r.left + r.right) / 2)),
            Math.max(0, Math.min(innerHeight - 1, (r.top + r.bottom) / 2)),
          );
          return e && (parent.contains(e) || e.contains(parent));
        })()
      ) {
        words.push(value);
        const link = parent.closest("a[href]"),
          sectionLink =
            link?.hash &&
            link.href.split("#")[0] === location.href.split("#")[0] &&
            !parent.closest("h1,h2,h3,h4,h5,h6,[role=heading]");
        // A table-of-contents label is navigation, not evidence of reading its section.
        if (!sectionLink) cache.readText.set(node, value);
        length += value.length;
      }
    }
  // Accessible labels carry visible control meaning that may not be in text nodes.
  for (const label of new Set(
    actions.map((action) => name(cache.nodes.get(action.node))),
  ))
    if (label && !words.includes(label)) words.push(label);
  const text = words.join("\n").slice(0, 6000),
    height = document.documentElement.scrollHeight;
  while (cache.readText.size > 1000)
    cache.readText.delete(cache.readText.keys().next().value);
  const read_text = [...cache.readText.values()].join("\n").slice(-16000);
  const page_key = cache.pageKey(),
    guards = {};
  for (const a of actions)
    if (!(a.node in guards))
      guards[a.node] = cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics = actions.map(({ rect, ...action }) => action);
  const pendingScripts =
    document.readyState !== "complete" &&
    [...document.scripts].some(
      (script) =>
        script.src &&
        (!script.async || script.fetchPriority === "high") &&
        !window.__jevLoadedScripts?.has(script),
    );
  const readiness =
    pendingScripts ||
    [...document.querySelectorAll('[aria-busy="true"]')].some(visible)
      ? "loading"
      : actions.length
        ? "ready"
        : document.readyState === "complete"
          ? "empty"
          : "loading";
  const marker = [
    performance.timeOrigin,
    location.href,
    scrollX,
    scrollY,
    innerWidth,
    innerHeight,
    document.title,
    text,
    read_text,
    semantics,
    page_key[6],
    readiness,
  ];
  const omitted_actions = Math.max(0, actions.length - 250);
  actions.splice(250);
  actions.forEach((a, i) => (a.id = "e" + (i + 1)));
  if (scrollY + innerHeight < height - 2)
    actions.push({
      id: "scroll_down",
      kind: "scroll",
      label: "Scroll down",
      delta: 560,
    });
  if (scrollY > 0)
    actions.push({
      id: "scroll_up",
      kind: "scroll",
      label: "Scroll up",
      delta: -560,
    });
  actions.push({
    id: "wait",
    kind: "wait",
    label: "Wait for the page to update",
  });
  return {
    document_id,
    discovery_limited,
    readiness,
    url: location.href,
    title: document.title,
    w: innerWidth,
    h: innerHeight,
    text,
    read_text,
    scroll: { y: scrollY, height },
    actions,
    marker,
    page_key,
    guards,
    omitted_actions,
  };
})();
