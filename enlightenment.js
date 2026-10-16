const MODULE_ID = "barbarian-enlightenment";
const FEATURE_NAME = "Enlightenment";
const MIN_TOTAL_BONUS = 5;

Hooks.once("ready", async () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      grantFeature: createEnlightenmentFeature,
      triggerEnlightenment: handleEnlightenmentPrompt
    };
  }

  // Automatically create the drag-and-drop Item in the World Items sidebar for the GM
  if (game.user.isGM) {
    const existingItem = game.items.find(
      (i) => i.getFlag(MODULE_ID, "isEnlightenmentFeature") || i.name.trim().toLowerCase() === FEATURE_NAME.toLowerCase()
    );
    if (!existingItem) {
      await Item.create(getEnlightenmentItemData());
      ui.notifications.info(`Barbarian Enlightenment: Added "${FEATURE_NAME}" to your Items tab! Drag it onto your Barbarian's sheet.`);
    }
  }
});

// dnd5e v4.0+ (2024 System) Activity Hook
Hooks.on("dnd5e.postUseActivity", async (activity) => {
  const item = activity?.item;
  const actor = activity?.actor;
  if (!item || !actor) return;

  if (item.getFlag(MODULE_ID, "isEnlightenmentFeature") || item.name.trim().toLowerCase() === FEATURE_NAME.toLowerCase()) {
    await handleEnlightenmentPrompt(actor, item);
  }
});

// Fallback Short Rest recovery if the item was created manually without a Short Rest recovery rule
Hooks.on("dnd5e.restCompleted", async (actor, result) => {
  if (result?.longRest) return;
  const item = actor.items.find(
    (i) => i.getFlag(MODULE_ID, "isEnlightenmentFeature") || i.name.trim().toLowerCase() === FEATURE_NAME.toLowerCase()
  );
  if (!item) return;

  const recoveryRules = item.system.uses?.recovery ?? [];
  if (!recoveryRules.some((r) => r.period === "sr")) {
    const currentSpent = item.system.uses?.spent ?? 0;
    if (currentSpent > 0) {
      await item.update({ "system.uses.spent": Math.max(0, currentSpent - 1) });
      ui.notifications.info(`${actor.name} regained 1 use of ${item.name} from a Short Rest.`);
    }
  }
});

// Dynamically recalculate the +5 minimum floor if Ability Scores or Proficiency Bonus change
Hooks.on("updateActor", async (actor, changed, options, userId) => {
  if (game.user.id !== userId) return;
  if (!changed.system?.abilities && !changed.system?.attributes && !changed.system?.skills) return;

  const activeEffect = findEnlightenmentEffect(actor);
  if (!activeEffect) return;

  const skillId = activeEffect.getFlag(MODULE_ID, "skillId");
  if (!skillId) return;

  const expectedFloorBonus = calculateFloorBonus(actor, skillId, activeEffect);
  const currentFloorChange = activeEffect.changes.find((c) => c.key === `system.skills.${skillId}.bonuses.check`);
  const currentBonusValue = Number(currentFloorChange?.value ?? 0);

  if (expectedFloorBonus !== currentBonusValue) {
    await activeEffect.update({ changes: buildEffectChanges(skillId, expectedFloorBonus) });
  }
});

function findEnlightenmentEffect(actor) {
  return actor.effects.find((e) => e.getFlag(MODULE_ID, "isEnlightenmentEffect"));
}

function calculateFloorBonus(actor, skillId, existingEffect = null) {
  const skillData = actor.system.skills?.[skillId];
  if (!skillData) return 0;

  const prof = actor.system.attributes?.prof ?? 2;
  const abilityMod = actor.system.abilities?.[skillData.ability]?.mod ?? 0;

  if (existingEffect && existingEffect.getFlag(MODULE_ID, "skillId") === skillId) {
    const ourPriorFloor = Number(
      existingEffect.changes.find((c) => c.key === `system.skills.${skillId}.bonuses.check`)?.value ?? 0
    );
    const rawTotalWithoutOurFloor = (skillData.total ?? 0) - ourPriorFloor;
    return Math.max(0, MIN_TOTAL_BONUS - rawTotalWithoutOurFloor);
  }

  const baseTotalUnproficient = skillData.total ?? abilityMod;
  const projectedTotalWithExpertise = baseTotalUnproficient + prof * 2;
  return Math.max(0, MIN_TOTAL_BONUS - projectedTotalWithExpertise);
}

function buildEffectChanges(skillId, floorBonus) {
  const changes = [
    {
      key: `system.skills.${skillId}.value`,
      mode: CONST.ACTIVE_EFFECT_MODES.UPGRADE,
      value: "2",
      priority: 20
    }
  ];
  if (floorBonus > 0) {
    changes.push({
      key: `system.skills.${skillId}.bonuses.check`,
      mode: CONST.ACTIVE_EFFECT_MODES.ADD,
      value: `+${floorBonus}`,
      priority: 20
    });
  }
  return changes;
}

async function handleEnlightenmentPrompt(actor, item) {
  const existingEffect = findEnlightenmentEffect(actor);
  const currentEnlightenedSkill = existingEffect?.getFlag(MODULE_ID, "skillId") ?? null;
  const prof = actor.system.attributes?.prof ?? 2;

  const eligibleSkills = [];
  for (const [skillId, skillConfig] of Object.entries(CONFIG.DND5E.skills)) {
    const actorSkill = actor.system.skills?.[skillId];
    if (!actorSkill || skillId === currentEnlightenedSkill) continue;

    if (actorSkill.value === 0) {
      const baseTotal = actorSkill.total ?? 0;
      const expertiseTotal = baseTotal + prof * 2;
      const finalTotal = Math.max(MIN_TOTAL_BONUS, expertiseTotal);
      const isFloored = expertiseTotal < MIN_TOTAL_BONUS;

      eligibleSkills.push({
        id: skillId,
        label: skillConfig.label,
        ability: skillConfig.ability.toUpperCase(),
        baseTotal: baseTotal >= 0 ? `+${baseTotal}` : `${baseTotal}`,
        finalTotal: `+${finalTotal}`,
        note: isFloored ? "Min +5 Floor" : "Double Prof"
      });
    }
  }

  if (eligibleSkills.length === 0) {
    ui.notifications.warn(`${actor.name} has no eligible unproficient skills to choose from.`);
    await refundUse(item);
    return;
  }

  eligibleSkills.sort((a, b) => a.label.localeCompare(b.label));

  const optionsHtml = eligibleSkills
    .map((s) => `<option value="${s.id}">${s.label} (${s.ability}) — ${s.baseTotal} ➔ ${s.finalTotal} [${s.note}]</option>`)
    .join("");

  const currentSkillBanner = currentEnlightenedSkill
    ? `<p style="margin-bottom: 8px; font-size: 0.9em; color: #b58900;">
         <strong>Currently Active:</strong> ${CONFIG.DND5E.skills[currentEnlightenedSkill]?.label} (will be replaced)
       </p>`
    : "";

  const content = `
    <div class="enlightenment-dialog">
      <p>Beseech the Light for a skill you do not originally possess:</p>
      ${currentSkillBanner}
      <div class="form-group">
        <label for="enlightenment-skill-select"><strong>Select Skill:</strong></label>
        <select id="enlightenment-skill-select" name="skillId" style="width: 100%; margin-top: 4px;">
          ${optionsHtml}
        </select>
      </div>
    </div>
  `;

  let selectedSkillId = null;
  if (foundry.applications?.api?.DialogV2) {
    try {
      selectedSkillId = await foundry.applications.api.DialogV2.prompt({
        window: { title: `${FEATURE_NAME}: Choose a Skill` },
        content,
        ok: {
          label: "Beseech the Light",
          icon: "fa-solid fa-sun",
          callback: (event, button, dialog) => {
            const selectEl = button.form?.elements?.skillId ?? dialog.element.querySelector("#enlightenment-skill-select");
            return selectEl?.value;
          }
        },
        rejectClose: false
      });
    } catch (err) {
      selectedSkillId = null;
    }
  } else {
    selectedSkillId = await Dialog.prompt({
      title: `${FEATURE_NAME}: Choose a Skill`,
      content,
      label: "Beseech the Light",
      callback: (html) => html.find("#enlightenment-skill-select").val(),
      rejectClose: false
    });
  }

  if (!selectedSkillId) {
    await refundUse(item);
    ui.notifications.info(`${FEATURE_NAME} canceled; use refunded.`);
    return;
  }

  const floorBonus = calculateFloorBonus(actor, selectedSkillId);
  const chosenSkillLabel = CONFIG.DND5E.skills[selectedSkillId]?.label ?? selectedSkillId;
  const previousSkillLabel = currentEnlightenedSkill ? CONFIG.DND5E.skills[currentEnlightenedSkill]?.label : null;

  if (existingEffect) {
    await existingEffect.delete();
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [
    {
      name: `${FEATURE_NAME}: ${chosenSkillLabel}`,
      img: item?.img || "icons/magic/light/explosion-star-glow-yellow.webp",
      origin: item?.uuid ?? actor.uuid,
      disabled: false,
      changes: buildEffectChanges(selectedSkillId, floorBonus),
      description: `<p>Granted double proficiency (minimum <strong>+5</strong> total bonus) in <strong>${chosenSkillLabel}</strong> via ${FEATURE_NAME}.</p>`,
      flags: {
        [MODULE_ID]: {
          isEnlightenmentEffect: true,
          skillId: selectedSkillId
        }
      }
    }
  ]);

  const updatedTotal = Math.max(MIN_TOTAL_BONUS, actor.system.skills?.[selectedSkillId]?.total ?? MIN_TOTAL_BONUS);
  const replacedText = previousSkillLabel ? `<p><em>Replaced previous skill: ${previousSkillLabel}</em></p>` : "";

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="dnd5e2 chat-card">
        <header class="card-header description">
          <img src="${item?.img || "icons/magic/light/explosion-star-glow-yellow.webp"}" width="36" height="36" />
          <div class="name-stacked">
            <span class="title">${FEATURE_NAME}</span>
            <span class="subtitle">Barbarian Feature</span>
          </div>
        </header>
        <section class="card-content">
          <p><strong>${actor.name}</strong> beseeches the Light and gains Enlightenment in <strong>${chosenSkillLabel}</strong> (Total Bonus: <strong>+${updatedTotal}</strong>).</p>
          ${replacedText}
        </section>
      </div>
    `
  });
}

async function refundUse(item) {
  if (!item) return;
  const spent = item.system.uses?.spent ?? 0;
  if (spent > 0) {
    await item.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }
}

function getEnlightenmentItemData() {
  return {
    name: FEATURE_NAME,
    type: "feat",
    img: "icons/magic/light/explosion-star-glow-yellow.webp",
    system: {
      description: {
        value: `<p>As a free action, you can beseech the Light for knowledge or practical skill you did not originally have. You double your proficiency bonus for this skill, but it cannot have a total bonus lower than +5.</p><p>You can do this a number of times equal to 1 + your proficiency bonus per Long Rest, replacing the skill you had previously each time you pick a new one. You regain one expended use when you finish a Short Rest.</p>`
      },
      type: { value: "class", subtype: "" },
      prerequisites: { level: 3 },
      uses: {
        max: "1 + @prof",
        spent: 0,
        recovery: [
          { period: "lr", type: "recoverAll" },
          { period: "sr", type: "formula", formula: "1" }
        ]
      },
      activities: {
        enlightenmentUse: {
          _id: "enlightenmentUse",
          type: "utility",
          name: "Beseech the Light",
          activation: { type: "special", condition: "Free Action" },
          consumption: { targets: [{ type: "itemUses", value: "1" }] }
        }
      }
    },
    flags: {
      [MODULE_ID]: { isEnlightenmentFeature: true }
    }
  };
}

async function createEnlightenmentFeature(actor) {
  actor = actor ?? canvas.tokens.controlled[0]?.actor ?? game.user.character;
  if (!actor) return ui.notifications.warn("Select a token first.");
  const [created] = await actor.createEmbeddedDocuments("Item", [getEnlightenmentItemData()]);
  ui.notifications.info(`Added "${created.name}" to ${actor.name}!`);
  return created;
}
