const FT_ID = "fathomless-tentacle";

// ---------- Utils ----------
function dbg(enabled, msg, obj) {
  if (!enabled) return;
  console.log(`[FT] ${msg}`, obj ?? "");
  try {
    ChatMessage.create({
      speaker: ChatMessage.getSpeaker(),
      content: `<small>[Debug] ${foundry.utils.escapeHTML(msg)}</small>`,
      whisper: [game.user.id]
    });
  } catch {}
}
function feetBetween(p1, p2, gridPx, feetPerGrid) {
  const dx = (p2.x - p1.x) / gridPx * feetPerGrid;
  const dy = (p2.y - p1.y) / gridPx * feetPerGrid;
  return Math.hypot(dx, dy);
}

// ---------- Settings, Hotkey, HUD ----------
Hooks.once("init", () => {
  game.settings.register(FT_ID, "actorName", {
    name: game.i18n.localize("FT.Settings.ActorName.Name"),
    hint: game.i18n.localize("FT.Settings.ActorName.Hint"),
    scope: "world", config: true, type: String, default: "Fathomless Tentacle"
  });
  game.settings.register(FT_ID, "itemName", {
    name: game.i18n.localize("FT.Settings.ItemName.Name"),
    hint: game.i18n.localize("FT.Settings.ItemName.Hint"),
    scope: "world", config: true, type: String, default: "Tentacle Strike"
  });
  game.settings.register(FT_ID, "maxDist", {
    name: game.i18n.localize("FT.Settings.MaxDist.Name"),
    hint: game.i18n.localize("FT.Settings.MaxDist.Hint"),
    scope: "world", config: true, type: Number, default: 60
  });
  game.settings.register(FT_ID, "debug", {
    name: game.i18n.localize("FT.Settings.Debug.Name"),
    hint: game.i18n.localize("FT.Settings.Debug.Hint"),
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(FT_ID, "spawnLinked", {
    name: game.i18n.localize("FT.Settings.SpawnLinked.Name"),
    hint: game.i18n.localize("FT.Settings.SpawnLinked.Hint"),
    scope: "world", config: true, type: Boolean, default: false
  });
  game.settings.register(FT_ID, "spawnDisposition", {
    name: game.i18n.localize("FT.Settings.SpawnDisposition.Name"),
    hint: game.i18n.localize("FT.Settings.SpawnDisposition.Hint"),
    scope: "world", config: true, type: Number, default: 1
  });

  game.keybindings.register(FT_ID, "fireTentacle", {
    name: "Fathomless Tentacle",
    editable: [{ key: "KeyT", modifiers: ["Alt"] }],
    onDown: () => game.fathomless?.tentacle(),
    restricted: false
  });
});

Hooks.once("ready", () => {
  game.fathomless = game.fathomless || {};
  game.fathomless.tentacle = tentacleFlow;

  // HUD-Button
  Hooks.on("renderTokenHUD", (hud, html) => {
    const btn = $(`<div class="control-icon" title="${game.i18n.localize("FT.HUD.Button")}"><i class="fas fa-water"></i></div>`);
    btn.on("click", () => game.fathomless.tentacle());
    html.find(".left-col").append(btn);
  });

  // GM-Socket Listener
  game.socket.on(`module.${FT_ID}`, async (msg) => {
    if (!game.user.isGM) return;
    if (msg?.op === "spawnTentacleToken") {
      const { actorId, x, y, disposition, linked } = msg.data;
      const actor = game.actors.get(actorId);
      if (!actor) return;
      const tData = actor.prototypeToken.toObject();
      tData.x = x; tData.y = y;
      tData.disposition = disposition;
      tData.actorLink = !!linked;
      const [doc] = await canvas.scene.createEmbeddedDocuments("Token", [tData]);
      game.socket.emit(`module.${FT_ID}`, { op: "spawnResult", data: { requestId: msg.data.requestId, tokenId: doc.id } });
    }
  });
});

// ---------- Hauptfluss ----------
async function tentacleFlow() {
  const DEBUG = game.settings.get(FT_ID, "debug");
  const actorName = game.settings.get(FT_ID, "actorName")?.trim();
  const itemName  = game.settings.get(FT_ID, "itemName")?.trim();
  const maxDist   = Number(game.settings.get(FT_ID, "maxDist")) || 60;
  const spawnLinked = !!game.settings.get(FT_ID, "spawnLinked");
  const spawnDisposition = Number(game.settings.get(FT_ID, "spawnDisposition")) ?? 1;

  const casterTok = canvas.tokens.controlled[0];
  if (!casterTok) return ui.notifications.warn("Wähle einen Caster-Token.");
  const caster = casterTok.actor;
  if (!caster) return ui.notifications.error("Kein Actor am Caster.");
  dbg(DEBUG, "Caster erkannt", { token: casterTok.name, actor: caster.name });

  const gridPx = canvas.grid.size;
  const feetPerGrid = canvas.scene.grid.distance || 5;

  // Punkt ≤ maxDist wählen
  ui.notifications.info(`Klicke einen Punkt in der Szene (max. ${maxDist} ft).`);
  const pos = await new Promise(resolve => {
    const handler = ev => {
      canvas.stage.off("mousedown", handler);
      const { x, y } = ev.data.getLocalPosition(canvas.app.stage);
      const snap = canvas.grid.getSnappedPosition(x, y, 1);
      resolve({ x: snap.x + gridPx / 2, y: snap.y + gridPx / 2 });
    };
    canvas.stage.on("mousedown", handler);
  });
  const dist = feetBetween(casterTok.center, pos, gridPx, feetPerGrid);
  dbg(DEBUG, "Gewählte Position", { x: pos.x, y: pos.y, distFt: dist.toFixed(1) });
  if (dist > maxDist + 0.001) return ui.notifications.warn(`Zu weit: ${dist.toFixed(1)} ft (max. ${maxDist} ft).`);
  try { canvas.ping(pos, { duration: 700 }); } catch {}

  // Ziel ≤10 ft um Punkt
  const enemies = canvas.tokens.placeables.filter(t => {
    if (!t.actor) return false;
    if (t.document.disposition === casterTok.document.disposition) return false;
    return feetBetween(pos, t.center, gridPx, feetPerGrid) <= 10.001;
  });
  dbg(DEBUG, "Gefundene Ziele im 10 ft Umkreis", enemies.map(t => t.name));
  if (enemies.length === 0) return ui.notifications.info("Kein Gegner im 10-ft-Umkreis.");

  const opts = enemies.map(t => `<option value="${t.id}">${foundry.utils.escapeHTML(t.name)}</option>`).join("");
  const targetId = await Dialog.prompt({
    title: "Ziel wählen",
    content: `<div class="form-group"><label>Ziel</label><select id="tgt">${opts}</select></div>`,
    label: "Weiter",
    callback: html => html.find("#tgt").val()
  });
  const targetTok = canvas.tokens.get(targetId);
  if (!targetTok) return ui.notifications.error("Ungültiges Ziel.");
  dbg(DEBUG, "Ziel gewählt", { target: targetTok.name, ac: targetTok.actor?.system?.attributes?.ac?.value });

  // Targets setzen
  try {
    if (typeof game.user.updateTargets === "function") {
      await game.user.updateTargets([targetTok], { releaseOthers: true });
    } else if (typeof game.user.updateTokenTargets === "function") {
      await game.user.updateTokenTargets([targetTok.id], { releaseOthers: true });
    }
    dbg(DEBUG, "Targets aktualisiert");
  } catch (e) { dbg(DEBUG, "Target-Setzung übersprungen", e); }

  const tentacleActor =
    game.actors.getName(actorName) ||
    game.actors.getName("Tentacle of the Deeps");
  if (!tentacleActor) {
    dbg(DEBUG, "Tentacle-Actor nicht gefunden", { actorName });
    return ui.notifications.warn(`Actor „${actorName}“ nicht gefunden.`);
  }

  // Token spawnen: direkt, oder via GM-Socket wenn keine Rechte
  let tentacleToken = null;
  try {
    // Prüfen, ob der User auf der Szene Token erstellen darf
    const canCreate = game.user.isGM || game.user.can("TOKEN_CREATE");
    if (canCreate) {
      const tData = tentacleActor.prototypeToken.toObject();
      tData.x = pos.x - gridPx / 2;
      tData.y = pos.y - gridPx / 2;
      tData.disposition = spawnDisposition;
      tData.actorLink = !!spawnLinked;
      const [doc] = await canvas.scene.createEmbeddedDocuments("Token", [tData]);
      tentacleToken = canvas.tokens.get(doc.id);
      dbg(DEBUG, "Token lokal gespawnt", { id: tentacleToken?.id });
    } else {
      // GM-Socket anfragen
      const requestId = randomID();
      const waitFor = new Promise(resolve => {
        const handler = (msg) => {
          if (msg?.op !== "spawnResult") return;
          if (msg?.data?.requestId !== requestId) return;
          game.socket.off(`module.${FT_ID}`, handler);
          resolve(msg.data.tokenId);
        };
        game.socket.on(`module.${FT_ID}`, handler);
      });
      game.socket.emit(`module.${FT_ID}`, {
        op: "spawnTentacleToken",
        data: {
          requestId,
          actorId: tentacleActor.id,
          x: pos.x - gridPx / 2,
          y: pos.y - gridPx / 2,
          disposition: spawnDisposition,
          linked: !!spawnLinked
        }
      });
      const tokId = await waitFor;
      tentacleToken = canvas.tokens.get(tokId);
      dbg(DEBUG, "Token via GM gespawnt", { id: tentacleToken?.id });
    }
  } catch (e) {
    dbg(DEBUG, "Spawn-Fehler", e);
  }

  if (!tentacleToken) {
    ui.notifications.warn("Tentacle-Token konnte nicht gespawnt werden.");
    return;
  }

  // Bonusaktion "Tentacle Strike" finden oder temporär anlegen
  let strike = tentacleToken.actor.items.getName(itemName);
  let tempCreated = false;
  if (!strike) {
    dbg(DEBUG, "Strike-Item nicht gefunden. Erzeuge temporär.");
    const itemData = {
      name: itemName,
      type: "spell",
      img: "icons/magic/water/tentacle-kraken-blue.webp",
      system: {
        level: 0, school: "evo",
        preparation: { mode: "innate", prepared: true },
        activation: { type: "bonus", cost: 1 },
        target: { value: 1, type: "creature" },
        range: { value: 10, units: "ft" },
        actionType: "msak",
        damage: { parts: [["1d8", "cold"]] },
        components: { vocal: false, somatic: false, material: false },
        concentration: false,
        scaling: { mode: "none", formula: "" },
        proficient: true
      },
      flags: { [FT_ID]: { ephemeral: true } }
    };
    const created = await tentacleToken.actor.createEmbeddedDocuments("Item", [itemData]);
    strike = created?.[0]; tempCreated = !!strike;
    dbg(DEBUG, "Temp-Strike erstellt", { id: strike?.id });
  }

  // Angriff: MidiQOL bevorzugt
  const hasMidi = game.modules.get("midi-qol")?.active;
  dbg(DEBUG, "MidiQOL Status", { hasMidi, version: game.modules.get("midi-qol")?.version });

  let used = false;
  if (hasMidi && strike && MidiQOL?.completeItemRoll) {
    try {
      dbg(DEBUG, "Starte MidiQOL.completeItemRoll");
      await MidiQOL.completeItemRoll(strike, {
        configureDialog: true,
        targetUuids: [targetTok.document.uuid],
        workflowOptions: { autoConsumeResources: false, autoRollDamage: "onHit" }
      });
      used = true;
    } catch (e) { dbg(DEBUG, "MidiQOL.completeItemRoll Fehler", e); }
  }
  if (!used && strike?.use) {
    try {
      dbg(DEBUG, "Starte strike.use");
      await strike.use({ configureDialog: true, createWorkflow: true, targetUuids: [targetTok.document.uuid] });
      used = true;
    } catch (e) { dbg(DEBUG, "strike.use Fehler", e); }
  }
  if (!used) {
    // Manueller Fallback
    dbg(DEBUG, "Manueller Fallback-Angriff");
    const scKey = tentacleToken.actor.system.attributes.spellcasting || "cha";
    const mod = tentacleToken.actor.system.abilities?.[scKey]?.mod ?? 0;
    const prof = tentacleToken.actor.system.attributes?.prof ?? 0;
    const atkBonus = mod + prof + (tentacleToken.actor.system.bonuses?.msak?.attack ?? 0);

    const mode = await new Promise(resolve => {
      const d = new Dialog({
        title: "Angriffsart",
        content: `<p>Wie willst du angreifen</p>
          <div class="form-group">
            <button data-mode="adv">Mit Vorteil</button>
            <button data-mode="norm">Normal</button>
            <button data-mode="dis">Mit Nachteil</button>
          </div>`,
        buttons: {},
        render: html => html.find("button").on("click", ev => { d.close(); resolve(ev.currentTarget.dataset.mode); })
      });
      d.render(true);
    }) || "norm";

    const d20 = mode === "adv" ? "2d20kh1" : mode === "dis" ? "2d20kl1" : "1d20";
    const attackRoll = await new Roll(`${d20} + ${atkBonus}`).roll({ async: true });
    attackRoll.toMessage({ speaker: ChatMessage.getSpeaker({ token: tentacleToken }), flavor: `${tentacleToken.name} greift ${targetTok.name} an (${mode})` });

    const ac = targetTok.actor?.system?.attributes?.ac?.value ?? 10;
    const isCrit = attackRoll.dice?.some?.(d => d.faces === 20 && d.results?.some?.(r => r.result === 20));
    const hit = isCrit || attackRoll.total >= ac;
    const dmgFormula = isCrit ? "2d8" : "1d8";
    const dmgRoll = await new Roll(dmgFormula).roll({ async: true });

    if (hit && hasMidi) {
      await MidiQOL.applyTokenDamage([{ damage: dmgRoll.total, type: "cold" }], dmgRoll.total, new Set([targetTok]), null, null);
      await dmgRoll.toMessage({ speaker: ChatMessage.getSpeaker({ token: tentacleToken }), flavor: `Kälteschaden (MidiQOL)` });
    } else if (hit) {
      await dmgRoll.toMessage({ speaker: ChatMessage.getSpeaker({ token: tentacleToken }), flavor: `Kälteschaden gegen AC ${ac}` });
    } else {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ token: tentacleToken }), content: `${tentacleToken.name} verfehlt ${targetTok.name}. AC ist ${ac}.` });
    }
  }

  // Aufräumen temporärer Strike
  if (tempCreated && strike) {
    try { await tentacleToken.actor.deleteEmbeddedDocuments("Item", [strike.id]); } catch {}
    dbg(DEBUG, "Temp-Strike gelöscht");
  }
}
