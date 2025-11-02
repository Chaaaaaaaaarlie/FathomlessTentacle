console.log("[FathomlessTentacle] init");

Hooks.once("init", () => {
  console.log("[FathomlessTentacle] Ready");
});

async function summonTentacle() {
  const caster = canvas.tokens.controlled[0]?.actor;
  if (!caster) return ui.notifications.warn("Kein Token ausgewählt.");
  console.log("[Debug] Caster erkannt");

  const spellMod = caster.system.abilities[caster.system.attributes.spellcasting].mod;
  const range = 60;
  const gridSize = canvas.grid.size;

  // 1) Spieler wählt Position
  const pos = await warpgate.crosshairs.show({
    size: 1,
    interval: 1,
    label: "Tentacle",
    drawIcon: true,
    icon: "icons/magic/water/tentacle-blue.webp",
    tag: "tentacle-preview",
    drawOutline: true
  });
  if (!pos) return;
  console.log("[Debug] Gewählte Position:", pos);

  // 2) Freies Feld finden
  const occupied = canvas.tokens.placeables.some(t =>
    Math.abs(t.x - pos.x) < gridSize && Math.abs(t.y - pos.y) < gridSize
  );
  let spawnPos = { x: pos.x, y: pos.y };
  if (occupied) {
    console.log("[Debug] Feld besetzt, suche nächstgelegene freie Position...");
    const offsets = [
      { x: gridSize, y: 0 }, { x: -gridSize, y: 0 },
      { x: 0, y: gridSize }, { x: 0, y: -gridSize }
    ];
    for (const off of offsets) {
      const nx = pos.x + off.x;
      const ny = pos.y + off.y;
      const blocked = canvas.tokens.placeables.some(t =>
        Math.abs(t.x - nx) < gridSize && Math.abs(t.y - ny) < gridSize
      );
      if (!blocked) { spawnPos = { x: nx, y: ny }; break; }
    }
  }

  // Vorschau-Highlight
  canvas.grid.highlightPosition(spawnPos);

  // 3) Alten Tentakel löschen
  const old = canvas.tokens.placeables.find(t =>
    t.name === "Fathomless Tentacle" &&
    t.actor?.id === caster.id
  );
  if (old) {
    console.log("[Debug] Alter Tentakel entfernt");
    await canvas.scene.deleteEmbeddedDocuments("Token", [old.id]);
  }

  // 4) Spawn via GM Socket (damit Player es darf)
  const spawnData = {
    name: "Fathomless Tentacle",
    x: spawnPos.x,
    y: spawnPos.y,
    img: "icons/magic/water/tentacle-blue.webp",
    disposition: caster.token.document.disposition,
    actorLink: false
  };

  const created = await game.socket.emit("module.FathomlessTentacle.spawn", spawnData);
  console.log("[Debug] Token spawn angefordert:", spawnData);

  // 5) Ziel finden (innerhalb 10 ft)
  const targets = Array.from(game.user.targets);
  if (!targets.length) {
    ui.notifications.info("Kein Ziel im 10 ft Umkreis gewählt.");
    return;
  }
  const target = targets[0];
  console.log("[Debug] Ziel gewählt:", target.name);

  // 6) Angriff via MidiQOL
  const attackRoll = await new CONFIG.Dice.D20Roll(`1d20 + ${spellMod}`).roll({async: true});
  const dmgRoll = await new Roll("1d8[cold]").roll({async: true});
  await MidiQOL.completeAttackRoll({
    actor: caster,
    itemUuid: null,
    attackRoll,
    damageRoll: dmgRoll,
    targetUuids: [target.document.uuid],
    workflowOptions: { autoRollDamage: true }
  });
}

// GM-Listener für Spawn
if (game.user.isGM) {
  game.socket.on("module.FathomlessTentacle.spawn", async (data) => {
    const created = await canvas.scene.createEmbeddedDocuments("Token", [data]);
    console.log("[Debug] Token gespawnt via GM Socket");
    return created[0];
  });
}

// Register hotkey (Alt+T)
Hooks.once("ready", () => {
  game.keybindings.register("FathomlessTentacle", "summon", {
    name: "Summon Fathomless Tentacle",
    hint: "Beschwört den Fathomless Tentacle an gewählter Position",
    editable: [{ key: "KeyT", modifiers: ["Alt"] }],
    onDown: summonTentacle
  });
});
