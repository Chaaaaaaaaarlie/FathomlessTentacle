// scripts/tentacle.js
const FT_ID = "fathomless-tentacle";

/* ------------------------- Helpers & Debug ------------------------- */
function dbg(enabled, msg, obj) {
  if (!enabled) return;
  console.log(`[FT] ${msg}`, obj ?? "");
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `<small>[Debug] ${foundry.utils.escapeHTML(msg)}</small>`,
    whisper: [game.user.id]
  }).catch(()=>{});
}
const feetBetween = (p1, p2, gridPx, feetPerGrid) => {
  const dx = (p2.x - p1.x) / gridPx * feetPerGrid;
  const dy = (p2.y - p1.y) / gridPx * feetPerGrid;
  return Math.hypot(dx, dy);
};
const waitSocket = (op, payload) => new Promise(resolve => {
  const rid = randomID();
  const handler = (msg) => {
    if (msg?.op !== `${op}:result`) return;
    if (msg?.data?.requestId !== rid) return;
    game.socket.off(`module.${FT_ID}`, handler);
    resolve(msg.data);
  };
  game.socket.on(`module.${FT_ID}`, handler);
  game.socket.emit(`module.${FT_ID}`, { op, data: { ...payload, requestId: rid } });
});

/* ------------------------- Settings / Hooks ------------------------- */
Hooks.once("init", () => {
  game.settings.register(FT_ID, "actorName", { scope:"world", config:true, type:String, default:"Fathomless Tentacle",
    name:"FT.Settings.ActorName.Name", hint:"FT.Settings.ActorName.Hint" });
  game.settings.register(FT_ID, "itemName",  { scope:"world", config:true, type:String, default:"Tentacle Strike",
    name:"FT.Settings.ItemName.Name", hint:"FT.Settings.ItemName.Hint" });
  game.settings.register(FT_ID, "maxDist",   { scope:"world", config:true, type:Number, default:60,
    name:"FT.Settings.MaxDist.Name", hint:"FT.Settings.MaxDist.Hint" });
  game.settings.register(FT_ID, "debug",     { scope:"client",config:true, type:Boolean,default:true,
    name:"FT.Settings.Debug.Name", hint:"FT.Settings.Debug.Hint" });
  game.settings.register(FT_ID, "spawnLinked",{scope:"world", config:true, type:Boolean, default:false,
    name:"FT.Settings.SpawnLinked.Name", hint:"FT.Settings.SpawnLinked.Hint" });
  game.settings.register(FT_ID, "spawnDisposition",{scope:"world",config:true,type:Number,default:1,
    name:"FT.Settings.SpawnDisposition.Name", hint:"FT.Settings.SpawnDisposition.Hint" });

  game.keybindings.register(FT_ID, "fireTentacle", {
    name: "Fathomless Tentacle", editable: [{ key:"KeyT", modifiers:["Alt"] }],
    onDown: () => game.fathomless?.tentacle(), restricted:false
  });
});

Hooks.once("ready", () => {
  game.fathomless ??= {};
  game.fathomless.tentacle = tentacleFlow;

  Hooks.on("renderTokenHUD",(hud,html)=>{
    const btn = $(`<div class="control-icon" title="Tentacle"><i class="fas fa-water"></i></div>`);
    btn.on("click", ()=> game.fathomless.tentacle());
    html.find(".left-col").append(btn);
  });

  // GM socket worker: spawn, despawn-by-caster, attack
  game.socket.on(`module.${FT_ID}`, async (msg) => {
    if (!game.user.isGM) return;
    try {
      if (msg.op === "spawn") {
        const { actorId, x, y, disposition, linked, casterUuid, requestId } = msg.data;
        // kill old tentacle(s) of this caster first
        const killers = canvas.tokens.placeables.filter(t => t.document.getFlag(FT_ID,"casterUuid") === casterUuid);
        if (killers.length) await canvas.scene.deleteEmbeddedDocuments("Token", killers.map(t=>t.id));
        const actor = game.actors.get(actorId); if (!actor) throw new Error("Actor not found");
        const tData = actor.prototypeToken.toObject();
        tData.x = x; tData.y = y;
        tData.disposition = disposition;
        tData.actorLink = !!linked;
        const [doc] = await canvas.scene.createEmbeddedDocuments("Token", [tData]);
        await doc.setFlag(FT_ID,"casterUuid", casterUuid);
        game.socket.emit(`module.${FT_ID}`, { op: "spawn:result", data: { requestId, tokenId: doc.id } });
      }

      if (msg.op === "despawnByCaster") {
        const { casterUuid, requestId } = msg.data;
        const killers = canvas.tokens.placeables.filter(t => t.document.getFlag(FT_ID,"casterUuid") === casterUuid);
        if (killers.length) await canvas.scene.deleteEmbeddedDocuments("Token", killers.map(t=>t.id));
        game.socket.emit(`module.${FT_ID}`, { op: "despawnByCaster:result", data: { requestId, removed: killers.length } });
      }

      if (msg.op === "attack") {
        const { tokenId, itemName, targetUuid, requestId } = msg.data;
        const tok = canvas.tokens.get(tokenId); if (!tok) throw new Error("Token not found");
        let strike = tok.actor.items.getName(itemName);
        let temp = false;
        if (!strike) {
          const itemData = {
            name: itemName, type: "spell",
            img: "icons/magic/water/tentacle-kraken-blue.webp",
            system: {
              level:0, school:"evo",
              preparation:{mode:"innate", prepared:true},
              activation:{type:"bonus", cost:1},
              target:{value:1, type:"creature"},
              range:{value:10, units:"ft"},
              actionType:"msak",
              damage:{ parts:[["1d8","cold"]] },
              components:{vocal:false, somatic:false, material:false},
              scaling:{mode:"none", formula:""}, proficient:true
            },
            flags:{[FT_ID]:{ephemeral:true}}
          };
          const [created] = await tok.actor.createEmbeddedDocuments("Item",[itemData]);
          strike = created; temp = true;
        }

        const hasMidi = game.modules.get("midi-qol")?.active;
        try {
          if (hasMidi && MidiQOL?.completeItemRoll) {
            await MidiQOL.completeItemRoll(strike, {
              configureDialog:true,
              targetUuids:[targetUuid],
              workflowOptions:{ autoConsumeResources:false, autoRollDamage:"onHit" }
            });
          } else if (strike?.use) {
            await strike.use({ configureDialog:true, createWorkflow:true, targetUuids:[targetUuid] });
          }
        } finally {
          if (temp && strike) await tok.actor.deleteEmbeddedDocuments("Item",[strike.id]).catch(()=>{});
          game.socket.emit(`module.${FT_ID}`, { op:"attack:result", data:{ requestId, ok:true } });
        }
      }
    } catch (e) {
      console.error("[FT GM worker]", e);
    }
  });
});

/* ------------------------- Main Flow ------------------------- */
async function tentacleFlow() {
  const DEBUG = game.settings.get(FT_ID,"debug");
  const actorName = game.settings.get(FT_ID,"actorName")?.trim();
  const itemName  = game.settings.get(FT_ID,"itemName")?.trim();
  const maxDist   = Number(game.settings.get(FT_ID,"maxDist")) || 60;
  const spawnLinked = !!game.settings.get(FT_ID,"spawnLinked");
  const spawnDisposition = Number(game.settings.get(FT_ID,"spawnDisposition")) ?? 1;

  const casterTok = canvas.tokens.controlled[0];
  if (!casterTok) return ui.notifications.warn("Wähle einen Caster-Token.");
  const caster = casterTok.actor; if (!caster) return ui.notifications.error("Kein Actor am Caster.");
  dbg(DEBUG,"Caster erkannt",{ token: casterTok.name, actor: caster.name });

  const gridPx = canvas.grid.size;
  const feetPerGrid = canvas.scene.grid.distance || 5;

  // Position wählen
  ui.notifications.info(`Klicke einen Punkt in der Szene (max. ${maxDist} ft, mit Sichtlinie).`);
  const pos = await new Promise(resolve=>{
    const handler = ev=>{
      canvas.stage.off("mousedown", handler);
      const { x, y } = ev.data.getLocalPosition(canvas.app.stage);
      const snap = canvas.grid.getSnappedPosition(x, y, 1);
      resolve({ x: snap.x + gridPx/2, y: snap.y + gridPx/2 });
    };
    canvas.stage.on("mousedown", handler);
  });
  const dist = feetBetween(casterTok.center, pos, gridPx, feetPerGrid);
  dbg(DEBUG,"Gewählte Position",{x:pos.x,y:pos.y,distFt:dist.toFixed(1)});
  if (dist > maxDist + 0.001) return ui.notifications.warn(`Zu weit: ${dist.toFixed(1)} ft (max. ${maxDist})`);

  // Sichtlinie prüfen (Spawnpunkt muss sichtbar sein)
  const ray = new Ray(casterTok.center, pos);
  const blocked = canvas.walls.checkCollision(ray, { type: "sight" });
  if (blocked) return ui.notifications.warn("Spawnpunkt ist nicht sichtbar (Sichtlinie blockiert).");

  try { canvas.ping(pos,{duration:700}); } catch{}

  // Ziele ≤10 ft um Punkt (feindlich)
  const enemies = canvas.tokens.placeables.filter(t=>{
    if (!t.actor) return false;
    if (t.document.disposition === casterTok.document.disposition) return false;
    return feetBetween(pos, t.center, gridPx, feetPerGrid) <= 10.001;
  });
  dbg(DEBUG,"Gefundene Ziele im 10 ft Umkreis", enemies.map(t=>t.name));
  if (!enemies.length) return ui.notifications.info("Kein Gegner im 10-ft-Umkreis.");

  // Ziel wählen
  const opts = enemies.map(t=>`<option value="${t.id}">${foundry.utils.escapeHTML(t.name)}</option>`).join("");
  const targetId = await Dialog.prompt({
    title:"Ziel wählen",
    content:`<div class="form-group"><label>Ziel</label><select id="tgt">${opts}</select></div>`,
    label:"Weiter",
    callback: html => html.find("#tgt").val()
  });
  const targetTok = canvas.tokens.get(targetId);
  if (!targetTok) return ui.notifications.error("Ungültiges Ziel.");
  dbg(DEBUG,"Ziel gewählt",{ target: targetTok.name, ac: targetTok.actor?.system?.attributes?.ac?.value });

  // Targets setzen (nur Komfort)
  try{
    if (typeof game.user.updateTargets === "function") await game.user.updateTargets([targetTok],{releaseOthers:true});
    else if (typeof game.user.updateTokenTargets === "function") await game.user.updateTokenTargets([targetTok.id],{releaseOthers:true});
    dbg(DEBUG,"Targets aktualisiert");
  } catch(e){ dbg(DEBUG,"Target-Setzung übersprungen", e); }

  // Tentacle-Actor auflösen
  const tentacleActor =
    game.actors.getName(actorName) || game.actors.getName("Tentacle of the Deeps");
  if (!tentacleActor) return ui.notifications.warn(`Actor „${actorName}“ nicht gefunden.`);

  /* --- NEU: erst alten Tentacle dieses Casters entfernen --- */
  const casterUuid = caster.uuid ?? casterTok.document.uuid;
  await waitSocket("despawnByCaster", { casterUuid });

  /* --- Spawn (lokal wenn möglich, sonst via GM) --- */
  const canCreate = game.user.isGM || game.user.can?.("TOKEN_CREATE");
  let tentacleToken = null;

  if (canCreate) {
    try {
      // lokal: erst löschen (falls vorhanden)
      const killers = canvas.tokens.placeables.filter(t => t.document.getFlag(FT_ID,"casterUuid") === casterUuid);
      if (killers.length) await canvas.scene.deleteEmbeddedDocuments("Token", killers.map(t=>t.id));
      const tData = tentacleActor.prototypeToken.toObject();
      tData.x = pos.x - gridPx/2; tData.y = pos.y - gridPx/2;
      tData.disposition = spawnDisposition; tData.actorLink = !!spawnLinked;
      const [doc] = await canvas.scene.createEmbeddedDocuments("Token",[tData]);
      await doc.setFlag(FT_ID,"casterUuid", casterUuid);
      tentacleToken = canvas.tokens.get(doc.id);
      dbg(DEBUG,"Token lokal gespawnt",{id: tentacleToken?.id});
    } catch(e) { dbg(DEBUG,"Spawn-Fehler (lokal)", e); }
  } else {
    // via GM
    const res = await waitSocket("spawn", {
      actorId: tentacleActor.id,
      x: pos.x - gridPx/2, y: pos.y - gridPx/2,
      disposition: spawnDisposition, linked: !!spawnLinked,
      casterUuid
    });
    tentacleToken = canvas.tokens.get(res?.tokenId);
    dbg(DEBUG,"Token via GM gespawnt",{id: tentacleToken?.id});
  }

  if (!tentacleToken) return ui.notifications.warn("Tentacle-Token konnte nicht gespawnt werden.");

  /* --- Angriff immer per GM (damit Player keine Rechte brauchen) --- */
  const attackRes = await waitSocket("attack", {
    tokenId: tentacleToken.id,
    itemName,
    targetUuid: targetTok.document.uuid
  });
  if (!attackRes?.ok) dbg(DEBUG,"Spawn-/Angriffsfehler");
}
