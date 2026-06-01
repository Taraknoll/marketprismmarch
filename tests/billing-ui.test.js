const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getTrialDaysRemaining,
  getSubscriptionPresentation,
  getPricingPagePresentation,
  canAccessFeature,
  getFeatureLockPresentation
} = require('../public/billing-ui.js');

test('getTrialDaysRemaining counts a future trial end date as days remaining', () => {
  const now = new Date('2026-03-31T12:00:00Z');
  const result = getTrialDaysRemaining('2026-04-07T11:59:59Z', now);

  assert.equal(result, 7);
});

test('getSubscriptionPresentation returns trial-specific billing copy', () => {
  const subscription = {
    status: 'trialing',
    current_period_end: '2026-04-07T11:59:59Z'
  };

  const presentation = getSubscriptionPresentation(subscription, {
    planName: 'MarketPrism Standard Trial',
    accessLevel: 'standard',
    hasPro: false,
    now: new Date('2026-03-31T12:00:00Z')
  });

  assert.equal(presentation.statusLabel, 'Trial');
  assert.equal(presentation.planCopy, 'Your 7-day free trial is active. Explore the dashboard before choosing a paid plan.');
  assert.equal(presentation.renewalCopy, 'Trial access ends in 7 days. Upgrade before then to keep your dashboard access unlocked.');
  assert.equal(presentation.accessLabel, 'Trial Access');
  assert.equal(presentation.accessCopy, 'Your trial currently unlocks the core paid dashboard experience until it expires.');
});

test('getSubscriptionPresentation handles same-day trial expiry messaging', () => {
  const subscription = {
    status: 'trialing',
    current_period_end: '2026-03-31T23:00:00Z'
  };

  const presentation = getSubscriptionPresentation(subscription, {
    planName: 'MarketPrism Standard Trial',
    accessLevel: 'standard',
    hasPro: false,
    now: new Date('2026-03-31T12:00:00Z')
  });

  assert.equal(presentation.renewalCopy, 'Trial access ends today. Upgrade now to avoid losing dashboard access.');
});

test('getPricingPagePresentation returns trial banner and button copy', () => {
  const subscription = {
    status: 'trialing',
    plan_id: 'standard_trial',
    current_period_end: '2026-04-07T11:59:59Z'
  };

  const presentation = getPricingPagePresentation(subscription, {
    planName: 'MarketPrism Standard Trial',
    now: new Date('2026-03-31T12:00:00Z')
  });

  assert.equal(presentation.bannerType, 'info');
  assert.equal(presentation.bannerText, 'Your 7-day free trial is active. 7 days remaining before paid access locks.');
  assert.equal(presentation.planStates.standard.buttonText, 'ON TRIAL');
  assert.equal(presentation.planStates.standard.metaText, 'Your trial currently includes Standard access until April 7, 2026.');
  assert.equal(presentation.planStates.pro.buttonText, 'UPGRADE TO PRO');
});

test('canAccessFeature denies standard feature access after trial expires', () => {
  const subscription = {
    status: 'canceled',
    plan_id: 'standard_trial'
  };

  assert.equal(canAccessFeature(subscription, 'standard'), false);
  assert.equal(canAccessFeature(subscription, 'free'), true);
});

test('canAccessFeature allows all dashboard features when testing override is enabled', () => {
  const subscription = {
    status: 'canceled',
    plan_id: 'standard_trial'
  };

  assert.equal(
    canAccessFeature(subscription, 'pro', { dashboardAccessOverride: true }),
    true
  );
});

test('getFeatureLockPresentation returns standard upgrade copy', () => {
  const presentation = getFeatureLockPresentation('standard', {
    title: 'Narrative History',
    detail: 'Deep event timelines and ticker-level story analysis.'
  });

  assert.equal(presentation.eyebrow, 'Standard Feature');
  assert.equal(presentation.title, 'Unlock Narrative History');
  assert.equal(presentation.body, 'Deep event timelines and ticker-level story analysis.');
  assert.equal(presentation.cta, 'Start Standard');
});

test('getFeatureLockPresentation returns pro upgrade copy', () => {
  const presentation = getFeatureLockPresentation('pro', {
    title: 'Score Any Stock',
    detail: 'AI-assisted scoring and premium decision support.'
  });

  assert.equal(presentation.eyebrow, 'Pro Feature');
  assert.equal(presentation.title, 'Upgrade to access Score Any Stock');
  assert.equal(presentation.cta, 'Upgrade to Pro');
});
