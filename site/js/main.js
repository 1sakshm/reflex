/* Page behaviour: masthead state, scroll reveals, install tabs, copy buttons, counters. */
(() => {
  const masthead = document.querySelector(".masthead");
  const darkSections = [...document.querySelectorAll(".section--dark, .closing, .footer")];

  // Masthead: frosted once scrolled; inverted over dark sections.
  const onScroll = () => {
    masthead.classList.toggle("is-scrolled", window.scrollY > 24);
    const probe = masthead.offsetHeight / 2;
    const overDark = darkSections.some((el) => {
      const r = el.getBoundingClientRect();
      return r.top <= probe && r.bottom >= probe;
    });
    masthead.classList.toggle("is-dark", overDark);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Reveal on scroll.
  const reveal = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        reveal.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
  );
  document.querySelectorAll(".reveal").forEach((el, i) => {
    el.style.transitionDelay = `${(i % 4) * 70}ms`;
    reveal.observe(el);
  });

  // Install tabs (WAI-ARIA tabs pattern, arrow-key navigation).
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.tabIndex = i === 0 ? 0 : -1;
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });

  // Copy buttons.
  const toast = document.querySelector(".toast");
  let toastTimer;
  const say = (msg) => {
    toast.textContent = msg;
    toast.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-on"), 1800);
  };
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        say("Copied ✦ " + (text.length > 34 ? text.slice(0, 34) + "…" : text));
      } catch {
        say("Copy failed — select it manually");
      }
    });
  });

  // Count-up for the big race number.
  const fmt = new Intl.NumberFormat("en-US");
  const counter = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        counter.unobserve(entry.target);
        const el = entry.target;
        const to = Number(el.dataset.countTo);
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const t0 = performance.now();
        const dur = 2200;
        const tick = (now) => {
          const k = Math.min(1, (now - t0) / dur);
          const eased = 1 - Math.pow(1 - k, 4);
          el.textContent = fmt.format(Math.round(to * eased));
          if (k < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    },
    { threshold: 0.6 },
  );
  document.querySelectorAll("[data-count-to]").forEach((el) => counter.observe(el));
})();
