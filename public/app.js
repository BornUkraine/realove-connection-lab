'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    providers: {},
    verified: {},
    groups: [],
    resolutionId: null,
    resolveGeneration: 0,
    planGeneration: 0,
    coachGeneration: 0,
    resolveController: null,
    planController: null,
    coachController: null,
    draft: '',
    starter: '',
    lastStatus: null,
  };
  const examples = {
    introduction: 'Hi! I noticed that we both enjoy live music. I would love to hear about something you have listened to lately. How can I make this introduction feel warm without putting pressure on the other person?',
    boundary: 'I enjoy getting to know you, but I would prefer not to share my phone number yet. I want to express that boundary kindly and clearly.',
    deescalation: 'I felt disappointed when our plan was cancelled. I do not know what happened, and I want to ask about it without assuming the other person does not care.',
  };

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = String(content);
    return element;
  }

  function text(value, fallback = '') {
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
  }

  function feedback(id, message, kind = 'info', cancel) {
    const element = $(id);
    element.replaceChildren(node('span', '', message));
    element.hidden = false;
    element.dataset.state = kind;
    element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    if (cancel) {
      const button = node('button', 'cancel-request', 'Stop waiting');
      button.type = 'button';
      button.addEventListener('click', cancel, { once: true });
      element.append(button);
    }
  }

  function clearFeedback(id) {
    $(id).hidden = true;
    $(id).replaceChildren();
  }

  function setBusy(button, busy, label, loadingLabel) {
    button.disabled = busy;
    button.textContent = busy ? loadingLabel : label;
    button.setAttribute('aria-busy', String(busy));
  }

  function readableError(error, provider) {
    if (error.name === 'AbortError') return 'Stopped waiting for this request. You can adjust your input and try again.';
    if (error.status === 503) return `${provider} access is not configured for this demo yet. No ${provider === 'Qloo' ? 'recommendations' : 'AI draft'} were generated.`;
    if (error.status === 401 || error.status === 403) return `${provider} did not authorise this request. The demo connection needs to be checked.`;
    if (error.status === 429) return `${provider} is receiving too many requests, or the demo has reached its request limit. Please try again later.`;
    if (error.status === 400 || error.status === 422) return error.publicMessage || 'Please check your input and try again.';
    if (error.status === 502 || error.status === 504) return `${provider} could not complete this request. Please try again later; no result has been invented.`;
    return error.publicMessage || 'The demo service could not be reached. Please check the connection and try again.';
  }

  async function request(path, payload, controller) {
    const response = await fetch(path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller?.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    let data;
    try { data = await response.json(); } catch {
      const failure = new Error('Unexpected service response');
      failure.status = response.status;
      throw failure;
    }
    if (!response.ok || data?.ok === false) {
      const failure = new Error('Demo request failed');
      failure.status = response.status;
      const publicMessage = data?.publicMessage || data?.error?.publicMessage || data?.error?.message || (typeof data?.error === 'string' ? data.error : '');
      // Show only a short public error, never provider dumps, credentials or tracebacks.
      if (typeof publicMessage === 'string' && !/api[_ -]?key|bearer\s|token\s*[:=]|sk-|traceback|stacktrace/i.test(publicMessage)) failure.publicMessage = publicMessage.slice(0, 300);
      throw failure;
    }
    return data;
  }

  function statusChip(id, provider, label) {
    const chip = $(id);
    const configured = provider?.configured === true;
    const verified = configured && state.verified[label.toLowerCase()] === true;
    const stateName = verified ? 'ready' : configured ? 'checking' : provider?.configured === false ? 'missing' : 'error';
    chip.dataset.state = stateName;
    chip.replaceChildren(node('span', ''), document.createTextNode(`${label} · ${verified ? 'API response received' : configured ? 'Configured, not yet tested' : provider?.configured === false ? 'Access not configured' : 'Service unavailable'}`));
    chip.title = configured ? 'Configuration is present. A successful request is still needed to verify provider access.' : 'No provider response is available until access is configured.';
  }

  function markProviderVerified(provider) {
    state.verified[provider] = true;
    if (state.providers[provider]?.configured) statusChip(`${provider}-status`, state.providers[provider], provider === 'qloo' ? 'Qloo' : 'Nebius');
  }

  async function refreshStatus() {
    $('refresh-status').disabled = true;
    try {
      const data = await request('/api/status');
      state.providers = data.providers || data;
      state.lastStatus = data;
      statusChip('qloo-status', state.providers.qloo, 'Qloo');
      statusChip('nebius-status', state.providers.nebius, 'Nebius');
    } catch {
      state.providers = {};
      statusChip('qloo-status', null, 'Qloo');
      statusChip('nebius-status', null, 'Nebius');
    } finally {
      $('refresh-status').disabled = false;
    }
  }

  function activateTab(name, moveFocus = false) {
    for (const candidate of ['culture', 'practice']) {
      const active = candidate === name;
      const tab = $(`tab-${candidate}`);
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      $(`panel-${candidate}`).hidden = !active;
      if (active && moveFocus) tab.focus();
    }
  }

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const name = event.key === 'Home' ? 'culture' : event.key === 'End' ? 'practice' : tab.dataset.tab === 'culture' ? 'practice' : 'culture';
      activateTab(name, true);
    });
  });

  function cleanConcepts() {
    const concepts = $('concepts').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    return [...new Map(concepts.map((value) => [value.toLocaleLowerCase(), value])).values()];
  }

  function normaliseEntity(value) {
    if (!value || typeof value !== 'object') return null;
    const id = text(value.id || value.entity_id || value.urn);
    const name = text(value.name || value.title || value.label);
    if (!id || !name) return null;
    return {
      id,
      name,
      type: text(value.type || value.entity_type, 'cultural reference'),
      description: text(value.description || value.properties?.description || value.summary),
      url: text(value.url || value.website || value.properties?.website),
      why: text(value.why || value.reason || value.explanation),
    };
  }

  function humanType(value) {
    return text(value, 'cultural reference').replace(/^urn:entity:/, '').replaceAll('_', ' ').replaceAll(':', ' ');
  }

  function invalidateCulture() {
    state.resolveGeneration += 1;
    state.planGeneration += 1;
    state.resolveController?.abort();
    state.planController?.abort();
    state.groups = [];
    state.resolutionId = null;
    state.starter = '';
    $('confirmation-section').hidden = true;
    $('culture-results').hidden = true;
    $('confirm-entities').checked = false;
    $('plan-button').disabled = true;
    clearFeedback('culture-feedback');
    setBusy($('resolve-button'), false, 'Find these interests →', 'Finding interests…');
    setBusy($('plan-button'), false, 'Explore shared ground →', 'Exploring shared ground…');
    $('plan-button').disabled = true;
  }

  $('concepts').addEventListener('input', invalidateCulture);
  $('culture-example').addEventListener('click', () => {
    invalidateCulture();
    $('concepts').value = 'Nina Simone\nSpirited Away\nThe Little Prince';
    $('concepts').focus();
  });

  function selectedEntities() {
    return state.groups.map((group, index) => {
      const selected = document.querySelector(`input[name="entity-${index}"]:checked`);
      return selected ? group.candidates[Number(selected.value)] : null;
    });
  }

  function updatePlanAvailability() {
    const selected = selectedEntities();
    const complete = Boolean(state.resolutionId) && state.groups.length > 0 && selected.length === state.groups.length && selected.every(Boolean);
    $('plan-button').disabled = !complete || !$('confirm-entities').checked;
  }

  function invalidatePlan(resetApproval = false) {
    state.planGeneration += 1;
    state.planController?.abort();
    state.starter = '';
    $('culture-results').hidden = true;
    if (resetApproval) $('confirm-entities').checked = false;
    clearFeedback('culture-feedback');
    setBusy($('plan-button'), false, 'Explore shared ground →', 'Exploring shared ground…');
    updatePlanAvailability();
  }

  function renderGroups(data, concepts) {
    state.resolutionId = text(data.resolutionId) || null;
    const supplied = Array.isArray(data.groups) ? data.groups : Array.isArray(data.results) ? data.results : [];
    state.groups = supplied.map((group, index) => ({
      query: text(group.query || group.concept || group.input, concepts[index] || `Interest ${index + 1}`),
      candidates: (Array.isArray(group.candidates) ? group.candidates : Array.isArray(group.entities) ? group.entities : Array.isArray(group.results) ? group.results : []).map(normaliseEntity).filter(Boolean).slice(0, 6),
    }));
    const container = $('entity-groups');
    container.replaceChildren();
    if (!state.groups.length) {
      feedback('culture-feedback', 'Qloo returned no matching references. Try a more specific artist, film or book title.');
      return;
    }
    for (const [groupIndex, group] of state.groups.entries()) {
      const fieldset = node('fieldset', 'entity-group');
      fieldset.append(node('legend', '', group.query));
      if (!group.candidates.length) fieldset.append(node('p', 'field-hint', 'No matching reference was returned. Change this interest above and search again.'));
      group.candidates.forEach((entity, candidateIndex) => {
        const label = node('label', 'entity-option');
        const input = node('input');
        input.type = 'radio';
        input.name = `entity-${groupIndex}`;
        input.value = String(candidateIndex);
        input.addEventListener('change', () => {
          invalidatePlan(true);
        });
        const details = node('span');
        details.append(node('span', 'entity-name', entity.name), node('span', 'entity-type', humanType(entity.type)));
        if (entity.description) details.append(node('span', 'entity-description', entity.description.slice(0, 240)));
        label.append(input, details);
        fieldset.append(label);
      });
      container.append(fieldset);
    }
    $('confirm-entities').checked = false;
    $('confirmation-section').hidden = false;
    updatePlanAvailability();
    const allFound = state.groups.every((group) => group.candidates.length > 0);
    feedback('culture-feedback', !state.resolutionId ? 'The search response did not include a confirmation session. Please search again before continuing.' : allFound ? 'Search complete. Please choose and confirm the intended references below.' : 'Some interests need a more specific search. Review the results below.', allFound && state.resolutionId ? 'success' : 'info');
  }

  $('culture-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const concepts = cleanConcepts();
    if (!concepts.length || concepts.length > 3 || concepts.some((value) => value.length > 120)) {
      feedback('culture-feedback', 'Enter one to three cultural interests, one per line, with no more than 120 characters each.', 'error');
      $('concepts').focus();
      return;
    }
    state.resolveController?.abort();
    state.planController?.abort();
    const generation = ++state.resolveGeneration;
    const controller = new AbortController();
    state.resolveController = controller;
    $('confirmation-section').hidden = true;
    $('culture-results').hidden = true;
    $('confirm-entities').checked = false;
    setBusy($('resolve-button'), true, 'Find these interests →', 'Finding interests…');
    feedback('culture-feedback', 'Looking up your cultural references with Qloo…', 'loading', () => controller.abort());
    try {
      const data = await request('/api/qloo/resolve', { concepts }, controller);
      if (generation !== state.resolveGeneration) return;
      markProviderVerified('qloo');
      renderGroups(data, concepts);
    } catch (error) {
      if (generation === state.resolveGeneration) feedback('culture-feedback', readableError(error, 'Qloo'), error.name === 'AbortError' ? 'info' : 'error');
    } finally {
      if (generation === state.resolveGeneration) setBusy($('resolve-button'), false, 'Find these interests →', 'Finding interests…');
    }
  });

  $('confirm-entities').addEventListener('change', () => invalidatePlan(false));
  $('culture-goal').addEventListener('change', () => invalidatePlan(false));

  function recommendationList(data) {
    const list = Array.isArray(data.recommendations) ? data.recommendations : Array.isArray(data.results) ? data.results : Array.isArray(data.entities) ? data.entities : data.results?.entities || [];
    return list.map(normaliseEntity).filter(Boolean).slice(0, 9);
  }

  function safeUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function renderStarters(supplied, recommendations) {
    const starters = Array.isArray(supplied) ? supplied.map((value) => text(value) || text(value?.text || value?.starter)).filter(Boolean).slice(0, 4) : [];
    // Explicit templates use the actual returned cultural reference, never invented API results.
    const options = starters.length ? starters : recommendations.slice(0, 3).map((entity) => `Have you come across ${entity.name}? I would be curious to hear what you think about it.`);
    $('starter-list').replaceChildren();
    $('starter-preview').hidden = true;
    state.starter = '';
    $('starter-section').hidden = options.length === 0;
    options.forEach((starter, index) => {
      const label = node('label', 'starter-option');
      const input = node('input');
      input.type = 'radio';
      input.name = 'starter';
      input.value = String(index);
      input.addEventListener('change', () => {
        state.starter = starter;
        $('starter-text').textContent = starter;
        $('starter-preview').hidden = false;
      });
      label.append(input, node('span', '', starter));
      $('starter-list').append(label);
    });
  }

  function renderPlan(data, entities) {
    const recommendations = recommendationList(data);
    const grid = $('recommendation-grid');
    grid.replaceChildren();
    if (!recommendations.length) {
      feedback('culture-feedback', 'Qloo returned no recommendations for this selection. Try a different confirmed interest. No fallback recommendations have been invented.');
      return;
    }
    for (const entity of recommendations) {
      const article = node('article', 'recommendation-card');
      article.append(node('span', 'result-type', humanType(entity.type)), node('h3', '', entity.name));
      if (entity.description || entity.why) article.append(node('p', '', (entity.description || entity.why).slice(0, 360)));
      const url = safeUrl(entity.url);
      if (url) {
        const anchor = node('a', '', 'Explore this reference ↗');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        article.append(anchor);
      }
      grid.append(article);
    }
    $('culture-result-context').textContent = `Based on your confirmed interests: ${entities.map((entity) => entity.name).join(', ')}. Choose what feels interesting to you.`;
    renderStarters(data.conversationStarters || data.starters, recommendations);
    const provider = text(data.source) || text(data.provenance?.provider || data.provenance?.source, 'Qloo API');
    $('culture-provenance').textContent = `Source: ${provider}. The references above came from this request. Conversation starters are optional wording, not statements about another person.`;
    $('culture-results').hidden = false;
    feedback('culture-feedback', 'Recommendations received. You decide which reference or conversation starter to explore.', 'success');
    $('culture-results').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }

  $('plan-button').addEventListener('click', async () => {
    const entities = selectedEntities();
    if (!state.resolutionId || !$('confirm-entities').checked || !entities.length || entities.some((entity) => !entity)) {
      feedback('culture-feedback', 'Choose and confirm the intended reference for every interest before continuing.', 'error');
      return;
    }
    state.planController?.abort();
    const controller = new AbortController();
    const generation = ++state.planGeneration;
    state.planController = controller;
    const inputGeneration = state.resolveGeneration;
    $('culture-results').hidden = true;
    setBusy($('plan-button'), true, 'Explore shared ground →', 'Exploring shared ground…');
    feedback('culture-feedback', 'Asking Qloo for related cultural references…', 'loading', () => controller.abort());
    try {
      const data = await request('/api/qloo/plan', { resolutionId: state.resolutionId, entities: entities.map(({ id, name, type }) => ({ id, name, type })), confirmed: true, goal: $('culture-goal').value }, controller);
      if (generation !== state.planGeneration || inputGeneration !== state.resolveGeneration) return;
      renderPlan(data, entities);
    } catch (error) {
      if (generation === state.planGeneration && inputGeneration === state.resolveGeneration) feedback('culture-feedback', readableError(error, 'Qloo'), error.name === 'AbortError' ? 'info' : 'error');
    } finally {
      if (generation === state.planGeneration) {
        setBusy($('plan-button'), false, 'Explore shared ground →', 'Exploring shared ground…');
        updatePlanAvailability();
      }
    }
  });

  function updateCoachCount() { $('coach-count').textContent = `${$('coach-message').value.length} / 1200`; }

  function invalidateCoach() {
    state.coachGeneration += 1;
    state.coachController?.abort();
    state.draft = '';
    $('coach-results').hidden = true;
    $('approve-draft').checked = false;
    $('copy-coach').disabled = true;
    clearFeedback('coach-feedback');
    setBusy($('coach-button'), false, 'Practise this conversation →', 'Finding thoughtful wording…');
    updateCoachCount();
  }

  $('coach-message').addEventListener('input', invalidateCoach);
  $('coach-goal').addEventListener('change', invalidateCoach);
  document.querySelectorAll('[data-coach-example]').forEach((button) => {
    button.addEventListener('click', () => {
      invalidateCoach();
      $('coach-goal').value = button.dataset.coachExample;
      $('coach-message').value = examples[button.dataset.coachExample];
      updateCoachCount();
      $('coach-message').focus();
    });
  });

  function renderCoach(data) {
    const draft = text(data.draft || data.response?.draft || data.result?.draft).trim();
    if (!draft) throw Object.assign(new Error('No draft returned'), { publicMessage: 'The model did not return a usable draft. Please try again with a shorter fictional example.' });
    state.draft = draft;
    $('coach-draft').textContent = draft;
    $('approve-draft').checked = false;
    $('copy-coach').disabled = true;
    const notes = data.notes || data.reflections || data.considerations;
    const noteList = Array.isArray(notes) ? notes.filter((value) => typeof value === 'string') : typeof notes === 'string' ? [notes] : [];
    $('coach-notes').replaceChildren();
    $('coach-notes').hidden = noteList.length === 0;
    if (noteList.length) {
      const list = node('ul');
      noteList.slice(0, 5).forEach((note) => list.append(node('li', '', note)));
      $('coach-notes').append(list);
    }
    const model = text(data.inference?.model || data.provenance?.model || data.model, 'NVIDIA model');
    const provider = text(data.inference?.provider || data.provenance?.provider, 'Nebius');
    $('coach-provenance').textContent = `Generated for this request by ${model} via ${provider}. Please review the wording and decide whether it fits your intention.`;
    $('coach-results').hidden = false;
    feedback('coach-feedback', 'A draft is ready for your review. It has not been sent to anyone.', 'success');
    $('coach-results').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }

  $('coach-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('coach-message').value.trim();
    if (message.length < 10 || message.length > 1200) {
      feedback('coach-feedback', 'Enter a fictional message or situation between 10 and 1,200 characters.', 'error');
      $('coach-message').focus();
      return;
    }
    state.coachController?.abort();
    const controller = new AbortController();
    const generation = ++state.coachGeneration;
    state.coachController = controller;
    $('coach-results').hidden = true;
    $('approve-draft').checked = false;
    setBusy($('coach-button'), true, 'Practise this conversation →', 'Finding thoughtful wording…');
    feedback('coach-feedback', 'Requesting a conversation-practice draft from the NVIDIA model on Nebius…', 'loading', () => controller.abort());
    try {
      const data = await request('/api/coach', { message, goal: $('coach-goal').value }, controller);
      if (generation !== state.coachGeneration) return;
      renderCoach(data);
      markProviderVerified('nebius');
    } catch (error) {
      if (generation === state.coachGeneration) feedback('coach-feedback', readableError(error, 'Nebius'), error.name === 'AbortError' ? 'info' : 'error');
    } finally {
      if (generation === state.coachGeneration) setBusy($('coach-button'), false, 'Practise this conversation →', 'Finding thoughtful wording…');
    }
  });

  let toastTimeout;
  function toast(message) {
    window.clearTimeout(toastTimeout);
    $('copy-feedback').textContent = message;
    $('copy-feedback').hidden = false;
    toastTimeout = window.setTimeout(() => { $('copy-feedback').hidden = true; }, 5000);
  }

  async function copy(value) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied. You decide where, whether and how to use it.');
    } catch { toast('Clipboard access is unavailable. You can select the wording and copy it manually.'); }
  }

  $('approve-draft').addEventListener('change', () => { $('copy-coach').disabled = !$('approve-draft').checked || !state.draft; });
  $('copy-coach').addEventListener('click', () => { if ($('approve-draft').checked) copy(state.draft); });
  $('copy-starter').addEventListener('click', () => copy(state.starter));
  $('refresh-status').addEventListener('click', refreshStatus);
  if (location.hash === '#practice') activateTab('practice');
  updateCoachCount();
  refreshStatus();
})();
