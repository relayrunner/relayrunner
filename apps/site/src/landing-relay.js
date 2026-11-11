(() => {
  const hero = document.querySelector(".hero .mascot"),
    actor = document.querySelector("#athlete"),
    course = document.querySelector("#course"),
    overhead = actor.querySelector("svg"),
    portrait = actor.querySelector("img");
  portrait.src = hero.src;
  const partner = actor.cloneNode(true);
  partner.removeAttribute("id");
  actor.after(partner);
  partner.querySelector("img").remove();
  const parked = partner.querySelector("svg");
  const activeBaton = overhead.querySelector('[fill="#f6c96c"]');
  const parkedBaton = parked.querySelector('[fill="#f6c96c"]');
  const transfer = document.createElement("div");
  transfer.setAttribute("aria-hidden", "true");
  transfer.style.cssText =
    "position:fixed;left:0;top:0;width:5px;height:16px;background:#f6c96c;border-radius:3px;pointer-events:none;z-index:16;display:none";
  actor.after(transfer);
  let exchange = -1,
    completed = false,
    entrySign = 1,
    homeMint = false;
  let approachX = 0,
    footerTarget = null,
    hasExchange = false,
    laps = 0,
    started = null;
  const podium = document.createElement("div");
  podium.className = "relay-podium";
  podium.setAttribute("role", "status");
  hero.after(podium);
  const split = document.createElement("output");
  split.className = "relay-split";
  hero.parentElement.style.position = "relative";
  hero.after(split);
  const startingLine = document.createElement("div");
  startingLine.className = "relay-start";
  startingLine.setAttribute("aria-hidden", "true");
  hero.after(startingLine);
  const splits = [];
  let lapStarted = null,
    splitTimer;
  function formatTime(elapsed) {
    const tenths = Math.floor(elapsed / 100);
    const minutes = Math.floor(tenths / 600);
    const seconds = String(Math.floor(tenths / 10) % 60).padStart(2, "0");
    return minutes + ":" + seconds + "." + (tenths % 10);
  }
  function showSplit(lap, elapsed) {
    splits.push(elapsed);
    split.textContent = "Lap " + lap + " · " + formatTime(elapsed);
    split.style.top = hero.offsetTop + hero.offsetHeight - 25 + "px";
    split.classList.add("visible");
    clearTimeout(splitTimer);
    splitTimer = setTimeout(() => split.classList.remove("visible"), 2200);
  }
  function celebrate(elapsed) {
    const label = document.createElement("span");
    label.textContent = "🏆 Total time";
    const total = document.createElement("b");
    total.textContent = formatTime(elapsed);
    podium.replaceChildren(label, total);
    const list = document.createElement("ol");
    const fastest = Math.min(...splits.map((ms) => Math.floor(ms / 100)));
    splits.forEach((ms, index) => {
      const row = document.createElement("li");
      const time = document.createElement("span");
      time.textContent = formatTime(ms);
      row.textContent = "Lap " + (index + 1);
      row.append(time);
      if (Math.floor(ms / 100) === fastest) {
        const mark = document.createElement("strong");
        mark.textContent = "Fastest";
        row.append(mark);
      }
      list.append(row);
    });
    podium.append(list);
    splits.length = 0;
    const easing = getComputedStyle(podium).getPropertyValue("--ease-out").trim();
    for (let i = 0; i < 30; i++) {
      const bit = document.createElement("i");
      bit.style.background = ["#43c966", "#ffd772", "#76dfe4"][i % 3];
      podium.append(bit);
      const dx = Math.cos(i * 2.4) * (65 + (i % 6) * 16);
      const motion = bit.animate(
        [
          { transform: "translate(0,-8px)", opacity: 1 },
          {
            transform:
              "translate(" + dx + "px,-" + (48 + (i % 7) * 13) + "px) rotate(" + i * 27 + "deg)",
            opacity: 1,
            offset: 0.54,
          },
          { transform: "translate(" + dx * 1.3 + "px,14px) rotate(" + i * 43 + "deg)", opacity: 0 },
        ],
        { duration: 850 + (i % 5) * 90, easing },
      );
      motion.onfinish = () => bit.remove();
    }
  }

  const reduce = matchMedia("(prefers-reduced-motion: reduce)"),
    clamp = (n) => Math.max(0, Math.min(1, n));
  let returnProgress = null;
  let scrollSpeed = 0;
  let previousScroll = scrollY;
  const limbs = overhead.querySelectorAll("g rect");
  const walk = { cadence: 1.3, reach: 2 };
  const jog = { cadence: 2.6, reach: 4 };
  const sprint = { cadence: 4, reach: 7 };
  let last = scrollY,
    side = 1,
    lane = 1,
    exitOffset = 0,
    lapY = scrollY,
    progress = 0,
    frame = 0,
    prevX,
    prevY,
    angle = 0,
    stride = 0,
    time = 0;
  function wake() {
    if (!frame) frame = requestAnimationFrame(draw);
  }
  function draw(now) {
    frame = 0;
    startingLine.style.top = hero.offsetTop + hero.offsetHeight + 1 + "px";
    startingLine.style.opacity = String(Math.max(0, 1 - scrollY / 65));
    if (reduce.matches) {
      hero.style.opacity = "";
      transfer.style.display = "none";
      return;
    }
    const elapsed = Math.max(1, now - time);
    const dt = Math.min(50, elapsed),
      k = 1 - Math.exp(-dt / 95);
    time = now;
    const y = Math.max(0, scrollY),
      w = innerWidth,
      h = innerHeight,
      box = hero.getBoundingClientRect(),
      home = box.top + box.height / 2;
    const scrollDelta = Math.abs(y - previousScroll);
    previousScroll = y;
    scrollSpeed += ((scrollDelta * 1000) / elapsed - scrollSpeed) * (1 - Math.exp(-elapsed / 85));
    if (Math.abs(y - last) > 1) {
      side = y > last ? 1 : -1;
      last = y;
    }
    const max = Math.max(1, document.documentElement.scrollHeight - h),
      launch = Math.min(240, box.height),
      target = clamp(y / launch);
    // Once the baton enters the home stretch, a downward nudge cannot rewind it.
    if (lane === -1 && target < 1) returnProgress = Math.min(returnProgress ?? 1, target);
    if (returnProgress !== null && box.bottom < 0 && target === 1 && side === 1) {
      returnProgress = null;
      lane = 1;
      exitOffset = h + box.height;
      entrySign = -1;
    }
    const remaining = max - y,
      contentLeft = document.querySelector(".stage").getBoundingClientRect().left,
      edge = Math.min(45, contentLeft / 2),
      inset = document.getElementById("relay-finish").offsetHeight / 2;
    if (started === null && y > 0) started = now;
    if (lapStarted === null && y > 0) lapStarted = now;
    if (y > launch && podium.textContent) podium.replaceChildren();
    if (remaining <= inset && footerTarget === null) footerTarget = y;
    if (remaining > inset + launch * 0.5 && exchange < 0) footerTarget = null;
    const switching =
      lane !== side && footerTarget === null && target === 1 && progress === 1 && exchange < 0;
    const outside = h + box.height;
    if (switching) {
      if (exitOffset === 0) entrySign = lane;
      exitOffset = Math.min(outside, exitOffset + dt * Math.max(1.8, h / 280));
      if (exitOffset === outside) {
        lane = side;
        prevX = prevY = undefined;
      }
    } else {
      exitOffset *= Math.exp(-dt / 110);
      if (exitOffset < 0.5) exitOffset = 0;
      if (progress === 0 && y > 0 && !exitOffset) lane = 1;
    }
    const laneSize = Math.min(64, edge * 1.42);
    const exchangeSize = Math.max(44, laneSize);
    const gap = exchangeSize * 0.37;
    const bend = Math.min(38, w * 0.08),
      corner = (Math.PI * bend) / 2;
    const straight = w / 2 - edge - bend - gap;
    const lead = clamp(1 - (max - lapY) / inset);
    const distanceToMark = (1 - lead) * (straight + corner);
    if (
      !completed &&
      lane === 1 &&
      footerTarget !== null &&
      exchange < 0 &&
      !exitOffset &&
      distanceToMark <= 3 * gap
    ) {
      exchange = 0;
      approachX = gap + distanceToMark;
    }
    if (exchange >= 0) {
      exchange = Math.min(1, exchange + dt / 650);
      if (exchange === 1) {
        lane = -1;
        completed = true;
        hasExchange = true;
        footerTarget = max;
        exchange = -1;
        lapY = max;
        prevX = prevY = undefined;
      }
    }
    if (footerTarget === null) completed = false;
    else footerTarget = lane === 1 ? Math.max(footerTarget, y) : Math.min(footerTarget, y);
    const pathTarget = exchange >= 0 ? max : (footerTarget ?? y);
    lapY += (pathTarget - lapY) * k;
    // Bind the hero morph to the scroll position, including jumps across the launch zone.
    progress = returnProgress ?? target;
    if (target < 1) {
      exitOffset = 0;
      prevX = prevY = undefined;
    }
    if (y === 0 && hasExchange) lane = -1;
    if (y === 0 && progress < 0.002 && !exitOffset) {
      if (lane === -1) homeMint = !homeMint;
      if (hasExchange) {
        hasExchange = false;
        laps++;
        showSplit(laps, now - lapStarted);
        lapStarted = null;
        if (laps === 3) {
          celebrate(now - started);
          laps = 0;
          started = null;
        }
      }
      returnProgress = null;
      progress = 0;
      lane = side = 1;
    }
    const p = progress,
      s = p * p * (3 - 2 * p),
      depth = clamp((lapY - launch) / Math.max(1, max - launch));
    const floor = h + remaining - inset;
    const arc = clamp(1 - (max - lapY) / inset);
    // Follow the quarter-circle and then the straight to the footer midpoint.
    const travel = arc * (corner + straight);
    const theta = Math.min(Math.PI / 2, travel / bend);
    const lateral = bend * (1 - Math.cos(theta)) + Math.max(0, travel - corner);
    const t = Math.max(0, exchange);
    const x =
      exchange >= 0
        ? w / 2 + gap + (approachX - gap) * (1 - t)
        : w / 2 + s * lane * (w / 2 - edge - lateral);
    const receiverX = w / 2 + gap * (1 - 2 * t * t);
    const partnerX = lane === 1 ? receiverX : w / 2 + gap;
    const wall = h * 0.25 + depth * (h - bend - h * 0.25);
    const ty = arc > 0 ? floor - bend + bend * Math.sin(theta) : wall;
    const stagger = lane === -1 ? gap * arc : 0;
    const vertical = clamp((s - 0.95) / 0.05);
    const py = -stagger + (1 - vertical) * home + vertical * ty + entrySign * exitOffset;
    const dx = x - (prevX ?? x),
      dy = py - (prevY ?? py),
      distance = Math.hypot(dx, dy);
    if (distance > 0.08) {
      let heading = (Math.atan2(dx, -dy) * 180) / Math.PI;
      angle += (((heading - angle + 540) % 360) - 180) * Math.min(1, dt / 75);
    }
    const gait = scrollSpeed < 70 ? walk : scrollSpeed > 1050 ? sprint : jog;
    const holding = returnProgress !== null && target > returnProgress;
    if (!holding && (distance > 0.08 || scrollDelta > 0)) {
      stride += (dt / 1000) * gait.cadence * Math.PI * 2;
    }
    prevX = x;
    prevY = py;
    // The footer has room to show the baton even on a narrow phone.
    const trackSize = laneSize + (exchangeSize - laneSize) * arc;
    const size = box.height * (1 - s) + trackSize * s;
    actor.style.transform =
      "translate(" + x + "px," + py + "px) translate(-50%,-50%) scale(" + size / 64 + ")";
    // Accelerate the receiver alongside the incoming runner through the exchange zone.
    partner.style.opacity = "1";
    partner.style.transform =
      "translate(" +
      partnerX +
      "px," +
      (floor - (lane === 1 ? gap : 0)) +
      "px) translate(-50%,-50%) scale(" +
      exchangeSize / 64 +
      ")";
    const mint = "hue-rotate(102deg)";
    const activeMint = lane === 1 ? homeMint : !homeMint;
    parked.style.filter = activeMint ? "" : mint;
    hero.style.filter = homeMint ? mint : "";
    portrait.style.filter = overhead.style.filter = activeMint ? mint : "";
    parked.style.transform = "rotate(-90deg)";
    for (const [i, limb] of [...parked.querySelectorAll("g rect")].entries())
      limb.setAttribute(
        "transform",
        "translate(0 " + Math.sin(t * t * gap * 0.35) * (i === 0 || i === 3 ? 4 : -4) + ")",
      );
    const pass = clamp((t - 0.42) / 0.32);
    parkedBaton.style.filter = activeMint ? "" : "hue-rotate(-102deg)";
    parkedBaton.style.visibility = pass === 1 ? "visible" : "hidden";
    activeBaton.style.filter = activeMint ? "hue-rotate(-102deg)" : "";
    activeBaton.style.visibility = pass > 0 ? "hidden" : "visible";
    transfer.style.display = pass > 0 && pass < 1 ? "block" : "none";
    if (exchange >= 0) {
      const handX = x + (receiverX - x) * pass;
      transfer.style.transform =
        "translate(" +
        (handX - gap * 0.25) +
        "px," +
        (floor - gap * (0.8 + pass) - Math.sin(pass * Math.PI) * 3) +
        "px) translate(-50%,-50%) rotate(90deg)";
    }
    if (footerTarget !== null && arc > 0) {
      angle = lane === 1 ? 180 + (theta * 180) / Math.PI : (-theta * 180) / Math.PI;
    }
    portrait.style.opacity = 1 - s;
    overhead.style.opacity = s;
    overhead.style.transform = "rotate(" + angle + "deg)";
    for (const [i, limb] of limbs.entries())
      limb.setAttribute(
        "transform",
        "translate(0 " + Math.sin(stride) * gait.reach * (i === 0 || i === 3 ? 1 : -1) + ")",
      );
    hero.style.opacity = p ? "0" : "";
    actor.style.opacity = p ? "1" : "0";
    course.style.opacity = s * 0.8;
    [...course.children].forEach((path, i) => {
      const a = edge + [-1, 1, 0][i] * Math.min(10, edge * 0.38),
        b = floor + (edge - a),
        bend = Math.min(38, w * 0.08);
      path.setAttribute(
        "d",
        "M " +
          a +
          " 0 V " +
          (b - bend) +
          " Q " +
          a +
          " " +
          b +
          " " +
          (a + bend) +
          " " +
          b +
          " H " +
          (w - a - bend) +
          " Q " +
          (w - a) +
          " " +
          b +
          " " +
          (w - a) +
          " " +
          (b - bend) +
          " V 0",
      );
    });
    if (exchange >= 0 || switching || exitOffset > 0 || Math.abs(pathTarget - lapY) > 0.01) wake();
  }
  addEventListener("scroll", wake, { passive: true });
  addEventListener("resize", wake);
  reduce.addEventListener("change", wake);
  addEventListener("load", wake);
  wake();
})();
