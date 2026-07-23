const root = document.documentElement;
const menuButton = document.querySelector("[data-menu-toggle]");
const navigation = document.querySelector("[data-site-nav]");
const header = document.querySelector("[data-site-header]");
const progressBar = document.querySelector("[data-scroll-progress]");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointerQuery = window.matchMedia("(hover: hover) and (pointer: fine)");

root.classList.add("motion-ready");

function prefersReducedMotion() {
  return reducedMotionQuery.matches;
}

function closeMenu() {
  if (!menuButton || !navigation) return;
  menuButton.setAttribute("aria-expanded", "false");
  navigation.classList.remove("open");
}

menuButton?.addEventListener("click", () => {
  const isOpen = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!isOpen));
  navigation?.classList.toggle("open", !isOpen);
});

navigation?.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

let scrollFrame = 0;
function updateScrollUi() {
  scrollFrame = 0;
  header?.classList.toggle("scrolled", window.scrollY > 16);

  if (progressBar) {
    const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, window.scrollY / scrollable));
    progressBar.style.transform = `scaleX(${progress})`;
  }
}

function requestScrollUiUpdate() {
  if (scrollFrame) return;
  scrollFrame = window.requestAnimationFrame(updateScrollUi);
}

updateScrollUi();
window.addEventListener("scroll", requestScrollUiUpdate, { passive: true });
window.addEventListener("resize", requestScrollUiUpdate, { passive: true });

const tabs = [...document.querySelectorAll("[data-code-tab]")];
const panels = [...document.querySelectorAll("[data-code-panel]")];

function activateCodeTab(tab) {
  const selected = tab.dataset.codeTab;
  tabs.forEach((candidate) => {
    const active = candidate === tab;
    candidate.classList.toggle("active", active);
    candidate.setAttribute("aria-selected", String(active));
    candidate.tabIndex = active ? 0 : -1;
  });

  panels.forEach((panel) => {
    const active = panel.dataset.codePanel === selected;
    panel.hidden = !active;
    panel.classList.toggle("is-switching", active);
    if (active) {
      window.setTimeout(() => panel.classList.remove("is-switching"), 420);
    }
  });
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateCodeTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    next?.focus();
    if (next) activateCodeTab(next);
  });
});

async function copyText(button) {
  const targetId = button.dataset.copyTarget;
  const target = targetId ? document.getElementById(targetId) : null;
  if (!target) return;

  const previous = button.textContent;
  try {
    await navigator.clipboard.writeText(target.textContent ?? "");
    button.textContent = "Copied";
    button.classList.add("copy-success");
  } catch {
    button.textContent = "Select text";
  }
  window.setTimeout(() => {
    button.textContent = previous;
    button.classList.remove("copy-success");
  }, 1600);
}

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => copyText(button));
});

const revealElements = [...document.querySelectorAll("[data-reveal]")];
revealElements.forEach((element) => {
  const delay = Number(element.dataset.revealDelay ?? 0);
  element.style.setProperty("--reveal-delay", `${Math.max(0, delay)}ms`);
});

document.querySelectorAll("[data-provider-cloud] .provider-logo").forEach((logo, index) => {
  logo.style.setProperty("--provider-index", String(index));
});

function revealImmediately() {
  revealElements.forEach((element) => element.classList.add("is-revealed"));
}

if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
  revealImmediately();
} else {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-revealed");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.14, rootMargin: "0px 0px -7%" },
  );
  revealElements.forEach((element) => revealObserver.observe(element));
}

const counterElements = [...document.querySelectorAll("[data-counter]")];

function formatCounter(element, value) {
  const decimals = Math.max(0, Number(element.dataset.counterDecimals ?? 0));
  const prefix = element.dataset.counterPrefix ?? "";
  const suffix = element.dataset.counterSuffix ?? "";
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  element.textContent = `${prefix}${formatted}${suffix}`;
}

function animateCounter(element) {
  if (element.dataset.counterAnimated === "true") return;
  element.dataset.counterAnimated = "true";
  const target = Number(element.dataset.counterValue ?? 0);
  const duration = 1150;

  if (prefersReducedMotion() || !Number.isFinite(target)) {
    formatCounter(element, target);
    return;
  }

  const started = performance.now();
  function tick(now) {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - progress, 4);
    formatCounter(element, target * eased);
    if (progress < 1) window.requestAnimationFrame(tick);
  }
  window.requestAnimationFrame(tick);
}

if (!("IntersectionObserver" in window)) {
  counterElements.forEach(animateCounter);
} else {
  const counterObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        animateCounter(entry.target);
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.55 },
  );
  counterElements.forEach((element) => counterObserver.observe(element));
}

const observedSections = [...document.querySelectorAll("[data-observe-section][id]")];
const sectionLinks = [...document.querySelectorAll('.site-nav a[href^="#"]')];

if (observedSections.length && sectionLinks.length && "IntersectionObserver" in window) {
  const sectionObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      sectionLinks.forEach((link) => {
        link.classList.toggle("active-link", link.getAttribute("href") === `#${visible.target.id}`);
      });
    },
    { rootMargin: "-28% 0px -58%", threshold: [0.01, 0.2, 0.5] },
  );
  observedSections.forEach((section) => sectionObserver.observe(section));
}

const routeDemo = document.querySelector("[data-route-demo]");
const replayButton = document.querySelector("[data-route-replay]");
const routeAnnouncer = document.querySelector("[data-route-announcer]");
const routeSteps = routeDemo ? [...routeDemo.querySelectorAll("[data-route-step]")] : [];
let routeTimers = [];

const routeAnnouncements = {
  request: "Request received.",
  model: "The free-router alias resolved using priority routing.",
  failure: "OpenRouter returned a rate limit and the router failed over.",
  success: "Groq completed the request successfully.",
  response: "The response was returned to the client.",
};

function clearRouteTimers() {
  routeTimers.forEach((timer) => window.clearTimeout(timer));
  routeTimers = [];
}

function showAllRouteSteps() {
  routeDemo?.classList.remove("route-playing");
  routeDemo?.classList.add("route-complete");
  routeSteps.forEach((step) => step.classList.add("route-step-visible"));
}

function playRouteTrace() {
  if (!routeDemo || !routeSteps.length) return;
  clearRouteTimers();
  routeDemo.classList.remove("route-complete");
  routeDemo.classList.add("route-playing");
  routeSteps.forEach((step) => step.classList.remove("route-step-visible"));
  replayButton?.classList.add("is-replaying");

  if (prefersReducedMotion()) {
    showAllRouteSteps();
    replayButton?.classList.remove("is-replaying");
    if (routeAnnouncer) routeAnnouncer.textContent = "Route trace completed successfully.";
    return;
  }

  const delays = [100, 480, 900, 1480, 2100];
  routeSteps.forEach((step, index) => {
    const timer = window.setTimeout(() => {
      step.classList.add("route-step-visible");
      const name = step.dataset.routeStep;
      if (routeAnnouncer && name) routeAnnouncer.textContent = routeAnnouncements[name] ?? "";
    }, delays[index] ?? index * 450);
    routeTimers.push(timer);
  });

  routeTimers.push(
    window.setTimeout(() => {
      routeDemo.classList.remove("route-playing");
      routeDemo.classList.add("route-complete");
      replayButton?.classList.remove("is-replaying");
    }, 2700),
  );
}

replayButton?.addEventListener("click", playRouteTrace);

if (routeDemo) {
  if (!("IntersectionObserver" in window) || prefersReducedMotion()) {
    showAllRouteSteps();
  } else {
    const routeObserver = new IntersectionObserver(
      (entries, observer) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        playRouteTrace();
        observer.disconnect();
      },
      { threshold: 0.46 },
    );
    routeObserver.observe(routeDemo);
  }
}

function enableHeroParallax() {
  if (!routeDemo || prefersReducedMotion() || !finePointerQuery.matches) return;
  const hero = routeDemo.closest(".hero");
  if (!hero) return;
  let pointerFrame = 0;
  let pointerX = 0;
  let pointerY = 0;

  function paintPointer() {
    pointerFrame = 0;
    const bounds = hero.getBoundingClientRect();
    const normalizedX = (pointerX - bounds.left) / Math.max(1, bounds.width) - 0.5;
    const normalizedY = (pointerY - bounds.top) / Math.max(1, bounds.height) - 0.5;
    routeDemo.style.setProperty("--parallax-x", `${normalizedX * 14}px`);
    routeDemo.style.setProperty("--parallax-y", `${normalizedY * 12}px`);
    routeDemo.style.setProperty("--parallax-rx", `${normalizedY * -2.2}deg`);
    routeDemo.style.setProperty("--parallax-ry", `${normalizedX * 2.8}deg`);
    hero.style.setProperty("--hero-pointer-x", `${(normalizedX + 0.5) * 100}%`);
    hero.style.setProperty("--hero-pointer-y", `${(normalizedY + 0.5) * 100}%`);
  }

  hero.addEventListener("pointermove", (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (!pointerFrame) pointerFrame = window.requestAnimationFrame(paintPointer);
  });

  hero.addEventListener("pointerleave", () => {
    routeDemo.style.removeProperty("--parallax-x");
    routeDemo.style.removeProperty("--parallax-y");
    routeDemo.style.removeProperty("--parallax-rx");
    routeDemo.style.removeProperty("--parallax-ry");
    hero.style.removeProperty("--hero-pointer-x");
    hero.style.removeProperty("--hero-pointer-y");
  });
}

enableHeroParallax();

function enableInteractiveCards() {
  if (prefersReducedMotion() || !finePointerQuery.matches) return;
  document.querySelectorAll("[data-interactive-card]").forEach((card) => {
    card.addEventListener("pointermove", (event) => {
      const bounds = card.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const rotateY = ((x / bounds.width) - 0.5) * 4.5;
      const rotateX = -((y / bounds.height) - 0.5) * 4.5;
      card.style.setProperty("--spot-x", `${x}px`);
      card.style.setProperty("--spot-y", `${y}px`);
      card.style.setProperty("--tilt-x", `${rotateX}deg`);
      card.style.setProperty("--tilt-y", `${rotateY}deg`);
      card.classList.add("is-pointed");
    });

    card.addEventListener("pointerleave", () => {
      card.classList.remove("is-pointed");
      card.style.removeProperty("--tilt-x");
      card.style.removeProperty("--tilt-y");
    });
  });
}

enableInteractiveCards();

reducedMotionQuery.addEventListener?.("change", () => {
  if (prefersReducedMotion()) {
    revealImmediately();
    counterElements.forEach(animateCounter);
    showAllRouteSteps();
  }
});
