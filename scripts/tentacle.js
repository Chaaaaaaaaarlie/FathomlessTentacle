// scripts/tentacle.js
const FT_MOD = game.modules.get("fathomless-tentacle")?.id ?? "fathomless-tentacle";

/* ---------- Utils & Debug ---------- */
function dbg(msg, data) {
  if (!game.settings.get(FT_MOD, "debug")) return;
  console.log(`[FT] ${msg}`, data ?? "");
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `<small>[Debug] ${foundry.utils.escapeHTML(msg)}</small>`,
    whisper: [game.user.id]
  }).catch(() => {});
}

function snapCenter(p) {
  const s = canvas.grid.getSnappedPosition(p.x, p.y, 1);
  const gs = canvas.grid.size;
  return { x: s.x + gs / 2, y: s.y + gs / 2 };
}
function feetBetween(a, b) {
  const gs = canvas.grid.size, fpg = canvas.scene.grid?.distance || 5;
  return Math.hypot((b.x - a.x) / gs * fpg, (b.y - a.y) / gs * fpg);
}
function isOccupied(center) {
  // token-bounds aware occupancy (handles >1x1 tokens)
  return canvas.tokens.placeables.some(t => t.bounds?.contains(center.x, center.y));
}
async function hasLOS(casterToken, point) {
  // User-independent sight test via walls collision
  const ray = new Ray(casterToken.center, point);
  return !canvas.walls.checkCollision(ray, { type: "sight" });
}
function* spiral(maxRadiusCells) {
  let x = 0, y = 0, dx = 1, dy = 0, len = 1, run = 0, turns = 0;
  yield [0, 0];
  while (run < (maxRadiusCells * maxRadiusCells + 5) * 4) {
    x += dx; y += dy; run++; yield [x, y];
    if (run % len === 0) { [dx, dy] = [-dy, dx]; turns++; if (turns % 2 === 0) len++; }
  }
}
function nearestFree(center, casterCenter, maxFeet, requireSight, casterToken) {
  const gs = canvas.grid.size, fpg = canvas.scene.grid?.distance || 5;
  const maxCells = Math.ceil(maxFeet / fpg) + 1;
  for (const [ox, oy] of spiral(maxCells)) {
    const c = { x: center.x + ox * gs, y: center.y + oy * gs };
    if (feetBetween(casterCenter, c) > maxFeet + 0.001) continue;
    if (requireSight && !(!canvas.walls.checkCollision(new Ray(casterCenter, c), { type: "sight" }))) continue;
    if (!isOccupied(c)) return c;
  }
  return null;
}

/* ---------- Socket RPC (req/resp) ---------- */
function socketAwait(op, payload) {
  return new Promise(resolve => {
    const requestId = randomID();
    const channel = `module.${FT_MOD}`;
    const handler = (msg) => {
      if (msg?.op !== `${op}:result`) return;
      if (msg?.data?.requestId !== requestId) return;
      game.socket.off(channel, handler);
      resolve(msg.data);
    };
    game.socket.on(channel, handler);
    game.socket.emit(channel, { op, data: { ...payload, requestId } });
  });
}

/* ---------- Settings ---------- */
Hooks.once("init", () => {
  game.settings.register(FT_MOD, "actorName", { scope: "world", config: true, type: String, default: "Fathomless Tentacle", name: "FT.Settings.ActorName.Name", hint: "" });
  game.settings.register(FT_MOD, "itemName", { scope: "world", config: true, type: String, default: "Tentacle Strike", name: "FT.Settings.ItemName.Name", hint: "" });
  game.settings.register(FT_MOD, "maxDist", { scope: "world", config: true, type: Number, default: 60, name: "FT.Settings.MaxDist.Name", hint: "" });
  game.settings.register(FT_MOD, "requireSight", { scope: "world", config: true, type: Boolean, default: true, name: "FT.Settings.RequireSight", hint: "Spawn nur bei Sichtlinie" });
  game.settings.register(FT_MOD, "spawnLinked", { scope: "world", config: true, type: Boolean, default: false, name: "FT.Settings.SpawnLinked.Name", hint: "" });
  game.settings.register(FT_MOD, "spawnDisposition", { scope: "world", config: true, type: Number, default: 1, name: "FT.Settings.SpawnDisposition.Name", hint: "" });
  game.settings.register(FT_MOD, "debug", { scope: "client", config: true, type: Boolean, default: true, name: "FT.Settings.Debug.Name", hint: "" });
});

/* ---------- Controls, Hotkey & Chat ---------- */
Hooks.once("ready", () => {
  // Hotkey Alt+T
  game.keybindings.register(FT_MOD, "summonTentacle", {
    name: "Fathomless Tentacle beschwören",
    editable: [{ key: "KeyT", modifiers: ["Alt"] }],
    onDown: () => summonTentacle(),
    restricted: false
  });

  // Chat command: /tentacle
  Hooks.on("chatMessage", (log, msg) => {
    if (msg.trim().toLowerCase() === "/tentacle") {
      summonTentacle();
      return false;
    }
  });

  // Button im Token-Controls
  Hooks.on("getSceneControlButtons", controls => {
    const tokenCtl = controls.find(c => c.name === "token");
    if (!tokenCtl) return;
    tokenCtl.tools.push({
      name: "ft-summon",
      title: "Fathomless Tentacle",
      icon: "fas fa-water",
      onClick: () => summonTentacle(),
      button: true
    });
  });

  // GM Worker
  game.socket.on(`module.${FT_MOD}`, async (msg) => {
    if (!game.user.isGM) return;
    try {
      if (msg.op === "despawnByCaster") {
        const { casterKey, requestId } = msg.data;
        const victims = canvas.tokens.placeables.filter(t => t.document.getFlag(FT_MOD, "casterKey") === casterKey);
        if (victims.length) await canvas.scene.deleteEmbeddedDocuments("Token", victims.map(t => t.id));
        game.socket.emit(`module.${FT_MOD}`, { op: "despawnByCaster:result", data: { requestId, removed: victims.length } });
      }
      if (msg.op === "spawn") {
        const { actorId, x, y, disposition, linked, casterKey, requestId } = msg.data;
        const actor = game.actors.get(actorId);
        if (!actor) throw new Error("Tentacle-Actor nicht gefunden.");
        // Safety: alte Tokens mit gleichem Caster-Key löschen
        const olds = canvas.tokens.placeables.filter(t => t.document.getFlag(FT_MOD, "casterKey") === casterKey);
        if (olds.length) await canvas.scene.deleteEmbeddedDocuments("Token", olds.map(t => t.id));
        const data = actor.prototypeToken.toObject();
        data.x = x; data.y = y; data.actorLink = !!linked; data.disposition = disposition ?? 1;
        const [doc] = await canvas.scene.createEmbeddedDocuments("Token", [data]);
        await doc.setFlag(FT_MOD, "casterKey", casterKey);
        game.socket.emit(`module.${FT_MOD}`, { op: "spawn:result", data: { requestId, tokenId: doc.id } });
      }
      if (msg.op === "attack") {
        const { tokenId, itemName, targetUuid, requestId } = msg.data;
        const tok = canvas.tokens.get(tokenId);
        const target = await fromUuid(targetUuid);
        let item = tok?.actor?.items.getName(itemName);
        let ephemeral = false;
        if (!item) {
          // Notfall: temporäres Angriffs-Item
          const [created] = await tok.actor.createEmbeddedDocuments("Item", [{
            name: itemName, type: "spell",
            img: "icons/magic/water/tentacle-kraken-blue.webp",
            system: {
              level: 0,
              activation: { type: "bonus", cost: 1 },
              target: { value: 1, type: "creature" },
              range: { value: 10, units: "ft" },
              actionType: "msak",
              damage: { parts: [["1d8", "cold"]] },
              scaling: { mode: "none" },
              preparation: { mode: "innate", prepared: true }
            }
          }]);
          item = created; ephemeral = true;
        }
        const hasMidi = game.modules.get("midi-qol")?.active && typeof MidiQOL?.completeItemRoll === "function";
        if (hasMidi) {
          await MidiQOL.completeItemRoll(item, {
            configureDialog: true,
            targetUuids: [targetUuid],
            workflowOptions: { autoRollDamage: "onHit" }
          });
        } else if (typeof item.use === "function") {
          await item.use({ configureDialog: true, targetUuids: [targetUuid], createWorkflow: true });
        }
        if (ephemeral) await tok.actor.deleteEmbeddedDocuments("Item", [item.id]).catch(() => {});
        game.socket.emit(`module.${FT_MOD}`, { op: "attack:result", data: { requestId, ok: true } });
      }
    } catch (e) { console.error("[FT GM worker error]", e); }
  });
});

/* ---------- Main Flow ---------- */
async function summonTentacle() {
  const actorName = game.settings.get(FT_MOD, "actorName") || "Fathomless Tentacle";
  const itemName  = game.settings.get(FT_MOD, "itemName")  || "Tentacle Strike";
  const maxDist   = Number(game.settings.get(FT_MOD, "maxDist")) || 60;
  const requireSight = !!game.settings.get(FT_MOD, "requireSight");
  const spawnLinked = !!game.settings.get(FT_MOD, "spawnLinked");
  const spawnDisposition = Number(game.settings.get(FT_MOD, "spawnDisposition")) ?? 1;

  const casterToken = canvas.tokens.controlled[0];
  if (!casterToken) return ui.notifications.warn("Wähle zuerst dein Caster-Token.");
  dbg("Caster erkannt", { token: casterToken.name });

  // Warnen, wenn kein GM aktiv ist
  const activeGM = game.users?.some(u => u.isGM && u.active);
  if (!activeGM) {
    return ui.notifications.error("Kein aktiver GM verbunden – Spawn nicht möglich.");
  }

  // --- Zielpunkt wählen: Canvas-Klick mit Grid-Highlight-Vorschau ---
  ui.notifications.info(`Klicke einen Punkt ≤ ${maxDist} ft${requireSight ? " (Sichtlinie)" : ""}.`);

  const layerId = "ft-preview";
  const previewLayer = canvas.grid.addHighlightLayer(layerId);
  const gs = canvas.grid.size;

  function drawPreview(c) {
    previewLayer.clear();
    canvas.grid.highlightPosition(layerId, {
      x: c.x - gs / 2,
      y: c.y - gs / 2,
      color: 0x00aaff,
      alpha: 0.5,
      border: 0x004466
    });
  }

  const moveHandler = ev => {
    const p = ev.data.getLocalPosition(canvas.app.stage);
    drawPreview(snapCenter(p));
  };
  canvas.stage.on("mousemove", moveHandler);

  const click = await new Promise(resolve => {
    const handler = ev => {
      canvas.stage.off("mousedown", handler);
      canvas.stage.off("mousemove", moveHandler);
      const p = ev.data.getLocalPosition(canvas.app.stage);
      resolve(snapCenter(p));
    };
    canvas.stage.on("mousedown", handler);
  });
  previewLayer.clear();

  dbg("Gewählte Position", click);

  // Reichweite + Sicht prüfen
  const dist = feetBetween(casterToken.center, click);
  if (dist > maxDist + 0.001) return ui.notifications.warn(`Zu weit: ${dist.toFixed(1)} ft (max. ${maxDist}).`);
  if (requireSight && !(await hasLOS(casterToken, click))) return ui.notifications.warn("Spawnpunkt nicht sichtbar.");

  // Freies Feld bestimmen
  let spawnCenter = isOccupied(click)
    ? (nearestFree(click, casterToken.center, maxDist, requireSight, casterToken) ?? click)
    : click;

  // einmal kurz „blinken“
  drawPreview(spawnCenter);
  setTimeout(() => previewLayer.clear(), 900);

  // Gegner ≤10 ft
  const enemies = canvas.tokens.placeables.filter(t => {
    if (!t.actor) return false;
    if (t.document.disposition === casterToken.document.disposition) return false;
    return feetBetween(spawnCenter, t.center) <= 10.001;
  });
  dbg("Gefundene Ziele im 10 ft Umkreis", enemies.map(t => t.name));
  if (!enemies.length) return ui.notifications.info("Kein Gegner im 10-ft-Umkreis.");

  // Zielauswahl Dialog
  const opts = enemies.map(t => `<option value="${t.id}">${foundry.utils.escapeHTML(t.name)}</option>`).join("");
  const targetId = await Dialog.prompt({
    title: "Ziel wählen",
    content: `<label>Ziel</label><select id="tgt">${opts}</select>`,
    label: "Weiter",
    callback: html => html.find("#tgt").val()
  });
  const targetTok = canvas.tokens.get(targetId); if (!targetTok) return;

  dbg("Ziel gewählt", { target: targetTok.name });
  try {
    if (typeof game.user.updateTargets === "function") await game.user.updateTargets([targetTok], { releaseOthers: true });
    else if (typeof game.user.updateTokenTargets === "function") await game.user.updateTokenTargets([targetTok.id], { releaseOthers: true });
    dbg("Targets aktualisiert");
  } catch {}

  const tentacleActor = game.actors.getName(actorName);
  if (!tentacleActor) return ui.notifications.warn(`Actor „${actorName}“ nicht gefunden.`);

  // Vorherige Tentacles dieses Casters entfernen (über GM)
  const casterKey = casterToken.document.uuid;
  await socketAwait("despawnByCaster", { casterKey });

  // GM spawnt
  const spawnRes = await socketAwait("spawn", {
    actorId: tentacleActor.id,
    x: spawnCenter.x - gs / 2, y: spawnCenter.y - gs / 2,
    disposition: spawnDisposition, linked: !!spawnLinked, casterKey
  });
  const tokenId = spawnRes?.tokenId; if (!tokenId) return ui.notifications.warn("Spawn fehlgeschlagen.");
  dbg("Token lokal gespawnt");

  // Angriff (Midi bevorzugt)
  await socketAwait("attack", {
    tokenId, itemName,
    targetUuid: targetTok.document.uuid
  });
}
