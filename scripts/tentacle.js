// scripts/tentacle.js
const FT_MOD = "fathomless-tentacle";

/* ===================== Utilities & Debug ===================== */
function dbg(msg, data) {
  const enabled = game.settings.get(FT_MOD, "debug");
  if (!enabled) return;
  console.log(`[FT] ${msg}`, data ?? "");
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `<small>[Debug] ${foundry.utils.escapeHTML(msg)}</small>`,
    whisper: [game.user.id]
  }).catch(() => {});
}

function snapToCenter(p) {
  const gs = canvas.grid.size;
  const s = canvas.grid.getSnappedPosition(p.x, p.y, 1);
  return { x: s.x + gs / 2, y: s.y + gs / 2 };
}

function feetBetween(a, b) {
  const gs = canvas.grid.size;
  const feetPerGrid = canvas.scene.grid?.distance || 5;
  const dx = (b.x - a.x) / gs * feetPerGrid;
  const dy = (b.y - a.y) / gs * feetPerGrid;
  return Math.hypot(dx, dy);
}

function hasSight(from, to) {
  const ray = new Ray(from, to);
  return !canvas.walls.checkCollision(ray, { type: "sight" });
}

function isOccupied(center) {
  // true, wenn die Kachel durch ein Token belegt ist
  for (const t of canvas.tokens.placeables) {
    const halfW = t.w / 2;
    const halfH = t.h / 2;
    if (Math.abs(center.x - t.center.x) <= halfW && Math.abs(center.y - t.center.y) <= halfH) {
      return true;
    }
  }
  return false;
}

function highlightCell(center, ms = 900, color = 0x00aaff) {
  const layerId = "ft-preview";
  const layer = canvas.grid.highlightLayers[layerId] ?? canvas.grid.addHighlightLayer(layerId);
  const gs = canvas.grid.size;
  const tlx = center.x - gs / 2;
  const tly = center.y - gs / 2;
  layer.clear();
  canvas.grid.highlightPosition(layerId, { x: tlx, y: tly, color, alpha: 0.5, border: 0x004466 });
  try { canvas.ping(center, { duration: ms }); } catch {}
  setTimeout(() => layer.clear(), ms);
}

function* spiral(maxSteps) {
  // Spiral-Offsets: (0,0),(1,0),(1,1),(0,1),(-1,1),...
  let x = 0, y = 0, dx = 1, dy = 0, step = 1, run = 0, turns = 0;
  yield [0, 0];
  while (run < maxSteps * maxSteps * 4) {
    x += dx; y += dy; run++;
    yield [x, y];
    if (run % step === 0) {
      [dx, dy] = [-dy, dx];
      turns++;
      if (turns % 2 === 0) step++;
    }
  }
}

function findNearestFreeCenter(startCenter, casterCenter, maxFeet, requireSight = true) {
  const gs = canvas.grid.size;
  const feetPerGrid = canvas.scene.grid?.distance || 5;
  const maxCells = Math.ceil(maxFeet / feetPerGrid) + 1;
  for (const [ox, oy] of spiral(maxCells)) {
    const c = { x: startCenter.x + ox * gs, y: startCenter.y + oy * gs };
    if (feetBetween(casterCenter, c) > maxFeet + 0.001) continue;
    if (requireSight && !hasSight(casterCenter, c)) continue;
    if (!isOccupied(c)) return c;
  }
  return null;
}

/** Request/Response über Socket – gibt ein Promise zurück */
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

/* ===================== Settings & Hotkey ===================== */
Hooks.once("init", () => {
  game.settings.register(FT_MOD, "actorName", { scope: "world", config: true, type: String, default: "Fathomless Tentacle", name: "FT.Settings.ActorName.Name", hint: "" });
  game.settings.register(FT_MOD, "itemName",  { scope: "world", config: true, type: String, default: "Tentacle Strike",       name: "FT.Settings.ItemName.Name",  hint: "" });
  game.settings.register(FT_MOD, "maxDist",   { scope: "world", config: true, type: Number, default: 60,                     name: "FT.Settings.MaxDist.Name",   hint: "" });
  game.settings.register(FT_MOD, "debug",     { scope: "client",config: true, type: Boolean, default: true,                  name: "FT.Settings.Debug.Name",     hint: "" });
  game.settings.register(FT_MOD, "spawnLinked",{scope: "world", config: true, type: Boolean, default: false,                 name: "FT.Settings.SpawnLinked.Name", hint: "" });
  game.settings.register(FT_MOD, "spawnDisposition",{scope:"world",config:true,type:Number,default:1,                        name: "FT.Settings.SpawnDisposition.Name", hint:"" });
});

Hooks.once("ready", () => {
  // Hotkey: Alt+T
  game.keybindings.register(FT_MOD, "tentacle", {
    name: "Fathomless Tentacle beschwören",
    editable: [{ key: "KeyT", modifiers: ["Alt"] }],
    onDown: () => summonTentacle(),
    restricted: false
  });

  // GM-Worker
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
        // Safety: alte Tokens dieses Casters entfernen
        const old = canvas.tokens.placeables.filter(t => t.document.getFlag(FT_MOD, "casterKey") === casterKey);
        if (old.length) await canvas.scene.deleteEmbeddedDocuments("Token", old.map(t => t.id));
        const actor = game.actors.get(actorId);
        if (!actor) throw new Error("Tentacle-Actor nicht gefunden");
        const tData = actor.prototypeToken.toObject();
        tData.x = x; tData.y = y; tData.disposition = disposition; tData.actorLink = !!linked;
        const [doc] = await canvas.scene.createEmbeddedDocuments("Token", [tData]);
        await doc.setFlag(FT_MOD, "casterKey", casterKey);
        game.socket.emit(`module.${FT_MOD}`, { op: "spawn:result", data: { requestId, tokenId: doc.id } });
      }
      if (msg.op === "attack") {
        const { tokenId, itemName, targetUuid, requestId } = msg.data;
        const tok = canvas.tokens.get(tokenId);
        const target = await fromUuid(targetUuid);
        let item = tok?.actor?.items.getName(itemName);
        // Fallback: temporäres Item
        let ephemeral = false;
        if (!item) {
          const data = {
            name: itemName, type: "spell",
            img: "icons/magic/water/tentacle-kraken-blue.webp",
            system: {
              level: 0, school: "evo",
              activation: { type: "bonus", cost: 1 },
              target: { value: 1, type: "creature" },
              range: { value: 10, units: "ft" },
              actionType: "msak",
              damage: { parts: [["1d8", "cold"]] },
              preparation: { mode: "innate", prepared: true },
              components: { vocal: false, somatic: false, material: false },
              scaling: { mode: "none", formula: "" }, proficient: true
            },
            flags: { [FT_MOD]: { ephemeral: true } }
          };
          const [created] = await tok.actor.createEmbeddedDocuments("Item", [data]);
          item = created; ephemeral = true;
        }
        const hasMidi = game.modules.get("midi-qol")?.active && typeof MidiQOL?.completeItemRoll === "function";
        try {
          if (hasMidi) {
            await MidiQOL.completeItemRoll(item, {
              configureDialog: true,
              targetUuids: [targetUuid],
              workflowOptions: { autoConsumeResources: false, autoRollDamage: "onHit" }
            });
          } else if (typeof item.use === "function") {
            await item.use({ configureDialog: true, targetUuids: [targetUuid], createWorkflow: true });
          } else if (typeof tok.actor.rollItem === "function") {
            await tok.actor.rollItem(item.id, { configureDialog: true });
          }
        } finally {
          if (ephemeral && item) await tok.actor.deleteEmbeddedDocuments("Item", [item.id]).catch(()=>{});
          game.socket.emit(`module.${FT_MOD}`, { op: "attack:result", data: { requestId, ok: true } });
        }
      }
    } catch (e) {
      console.error("[FT GM worker error]", e);
    }
  });
});

/* ===================== Main Flow ===================== */
async function summonTentacle() {
  const actorName = game.settings.get(FT_MOD, "actorName")?.trim() || "Fathomless Tentacle";
  const itemName  = game.settings.get(FT_MOD, "itemName")?.trim()  || "Tentacle Strike";
  const maxDist   = Number(game.settings.get(FT_MOD, "maxDist")) || 60;
  const spawnLinked = !!game.settings.get(FT_MOD, "spawnLinked");
  const spawnDisposition = Number(game.settings.get(FT_MOD, "spawnDisposition")) ?? 1;

  const casterToken = canvas.tokens.controlled[0];
  if (!casterToken) return ui.notifications.warn("Wähle zuerst dein Caster-Token.");
  const caster = casterToken.actor;
  dbg("Caster erkannt", { token: casterToken.name });

  // Punkt wählen (ohne Warpgate): ein Klick ins Canvas
  ui.notifications.info(`Klicke einen Punkt ≤ ${maxDist} ft (Sichtlinie erforderlich).`);
  const click = await new Promise(resolve => {
    const handler = ev => {
      canvas.stage.off("mousedown", handler);
      const p = ev.data.getLocalPosition(canvas.app.stage);
      resolve(snapToCenter(p));
    };
    canvas.stage.on("mousedown", handler);
  });
  dbg("Gewählte Position", click);

  // Reichweite + Sicht
  const dist = feetBetween(casterToken.center, click);
  if (dist > maxDist + 0.001) return ui.notifications.warn(`Zu weit: ${dist.toFixed(1)} ft (max. ${maxDist}).`);
  if (!hasSight(casterToken.center, click)) return ui.notifications.warn("Spawnpunkt nicht sichtbar.");

  // Freies Feld ermitteln
  let spawnCenter = isOccupied(click)
    ? (findNearestFreeCenter(click, casterToken.center, maxDist, true) ?? click)
    : click;
  highlightCell(spawnCenter);
  dbg("Vorschau Feld", spawnCenter);

  // Ziele ≤10 ft um Spawnpunkt
  const enemies = canvas.tokens.placeables.filter(t => {
    if (!t.actor) return false;
    // feindliche Disposition? Wenn du neutralen Spawn willst, entferne diese Zeile:
    if (t.document.disposition === casterToken.document.disposition) return false;
    return feetBetween(spawnCenter, t.center) <= 10.001;
  });
  dbg("Gefundene Ziele im 10 ft Umkreis", enemies.map(t => t.name));
  if (!enemies.length) return ui.notifications.info("Kein Gegner im 10-ft-Umkreis.");

  // Zielauswahl
  const opts = enemies.map(t => `<option value="${t.id}">${foundry.utils.escapeHTML(t.name)}</option>`).join("");
  const targetId = await Dialog.prompt({
    title: "Ziel wählen",
    content: `<div class="form-group"><label>Ziel</label><select id="tgt">${opts}</select></div>`,
    label: "Weiter",
    callback: html => html.find("#tgt").val()
  });
  const targetTok = canvas.tokens.get(targetId);
  if (!targetTok) return ui.notifications.error("Ungültiges Ziel.");
  dbg("Ziel gewählt", { target: targetTok.name });

  // Komfort: Targets aktualisieren
  try {
    if (typeof game.user.updateTargets === "function") await game.user.updateTargets([targetTok], { releaseOthers: true });
    else if (typeof game.user.updateTokenTargets === "function") await game.user.updateTokenTargets([targetTok.id], { releaseOthers: true });
    dbg("Targets aktualisiert");
  } catch (e) { dbg("Targets-Update übersprungen", e); }

  // Tentacle-Actor holen
  const tentacleActor = game.actors.getName(actorName);
  if (!tentacleActor) return ui.notifications.warn(`Actor „${actorName}“ nicht gefunden.`);

  // Eindeutiger Caster-Key => Despawn alter Tentakel (GM)
  const casterKey = casterToken.document.uuid;
  await socketAwait("despawnByCaster", { casterKey });
  dbg("Älteren Tentacle entfernt, falls vorhanden");

  // Spawn via GM
  const gs = canvas.grid.size;
  const spawnRes = await socketAwait("spawn", {
    actorId: tentacleActor.id,
    x: spawnCenter.x - gs/2,
    y: spawnCenter.y - gs/2,
    disposition: spawnDisposition,
    linked: !!spawnLinked,
    casterKey
  });
  const tokenId = spawnRes?.tokenId;
  if (!tokenId) return ui.notifications.warn("Spawn fehlgeschlagen.");
  dbg("Token lokal gespawnt");

  // Angriff via GM (MidiQOL bevorzugt)
  const atkRes = await socketAwait("attack", {
    tokenId,
    itemName,
    targetUuid: targetTok.document.uuid
  });
  if (!atkRes?.ok) dbg("Angriff fehlgeschlagen");
}
