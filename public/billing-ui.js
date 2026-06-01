(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
    return;
  }
  root.MP_BILLING_UI = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  function normalizeSubscriptionStatus(status){
    var normalized = String(status || '').trim().toLowerCase();
    if(!normalized) return 'inactive';
    return normalized.replace(/[^a-z]+/g, '_');
  }

  function formatBillingDate(value){
    if(!value) return 'Not available';
    var date = new Date(value);
    if(isNaN(date.getTime())) return 'Not available';
    return date.toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' });
  }

  function getTrialDaysRemaining(value, now){
    if(!value) return null;
    var trialEnd = new Date(value);
    var current = now ? new Date(now) : new Date();
    if(isNaN(trialEnd.getTime()) || isNaN(current.getTime())) return null;
    if(
      trialEnd.getUTCFullYear() === current.getUTCFullYear() &&
      trialEnd.getUTCMonth() === current.getUTCMonth() &&
      trialEnd.getUTCDate() === current.getUTCDate()
    ){
      return 0;
    }
    var diff = trialEnd.getTime() - current.getTime();
    if(diff <= 0) return 0;
    return Math.ceil(diff / 86400000);
  }

  function getSubscriptionPresentation(subscription, options){
    var opts = options || {};
    var status = normalizeSubscriptionStatus(subscription && subscription.status);
    var renewalDate = subscription && (subscription.current_period_end || subscription.cancel_at || subscription.ended_at);
    var daysRemaining = status === 'trialing' ? getTrialDaysRemaining(renewalDate, opts.now) : null;

    if(status === 'trialing'){
      return {
        status: status,
        statusLabel: 'Trial',
        planCopy: 'Your free trial is active. Explore the full platform before subscribing.',
        renewalDateText: formatBillingDate(renewalDate),
        renewalCopy: daysRemaining === 0
          ? 'Trial access ends today. Subscribe now to keep your access.'
          : 'Trial access ends in ' + daysRemaining + ' day' + (daysRemaining === 1 ? '' : 's') + '. Subscribe before then to keep your access.',
        accessLabel: 'Trial Access',
        accessCopy: 'Your trial unlocks full platform access until it expires.',
        planName: opts.planName || 'Trial'
      };
    }

    return {
      status: status,
      statusLabel: status === 'past_due' ? 'Past Due' : status === 'canceled' ? 'Canceled' : status === 'active' ? 'Active' : 'Inactive',
      planCopy: status === 'active'
        ? 'Your subscription is active. Full platform access is unlocked.'
        : 'No active subscription found. Subscribe to unlock the full platform.',
      renewalDateText: formatBillingDate(renewalDate),
      renewalCopy: renewalDate
        ? (status === 'canceled' ? 'Your access will end on the date above.' : 'Next renewal on the date above.')
        : 'Subscribe and this card will show your next renewal date.',
      accessLabel: status === 'active' ? 'Full Access' : 'Subscribe to Unlock',
      accessCopy: status === 'active'
        ? 'All tools unlocked: Signal Lab, Trading Cards, Leaderboard, Trading Calendar, and more.'
        : 'Subscribe to access Signal Lab, Trading Cards, Leaderboard, Trading Calendar, and all platform features.',
      planName: opts.planName || 'No Active Plan'
    };
  }

  function getPricingPagePresentation(subscription, options){
    var opts = options || {};
    var status = normalizeSubscriptionStatus(subscription && subscription.status);
    var planName = opts.planName || 'No Active Plan';
    var renewalDate = subscription && (subscription.current_period_end || subscription.cancel_at || subscription.ended_at);
    var formattedDate = formatBillingDate(renewalDate);
    var daysRemaining = status === 'trialing' ? getTrialDaysRemaining(renewalDate, opts.now) : null;
    var planStates = {
      pro: {
        buttonText: 'GET FOUNDING ACCESS — $25/MONTH',
        disabled: false,
        metaText: '$25/month rate locked in for 12 months for founding members.'
      }
    };

    if(status === 'trialing'){
      planStates.pro.buttonText = 'SUBSCRIBE NOW';
      planStates.pro.metaText = 'Your trial ends ' + formattedDate + '. Subscribe to keep full access.';
      return {
        bannerType: 'info',
        bannerText: 'Your free trial is active. ' + (daysRemaining === 0 ? 'It ends today.' : daysRemaining + ' day' + (daysRemaining === 1 ? '' : 's') + ' remaining.'),
        planName: planName,
        planStates: planStates
      };
    }

    if(status === 'active'){
      planStates.pro.buttonText = 'CURRENT PLAN';
      planStates.pro.disabled = true;
      planStates.pro.metaText = 'Your subscription is active through ' + formattedDate + '.';
      return {
        bannerType: 'success',
        bannerText: 'You have full access to Market Prism.',
        planName: planName,
        planStates: planStates
      };
    }

    return {
      bannerType: '',
      bannerText: '',
      planName: planName,
      planStates: planStates
    };
  }

  // Single tier — any active subscription grants full access
  function canAccessFeature(subscription, requiredPlan, options){
    var opts = options || {};
    if(opts.dashboardAccessOverride) return true;
    if(requiredPlan === 'free' || !requiredPlan) return true;
    var status = normalizeSubscriptionStatus(subscription && subscription.status);
    return status === 'active' || status === 'trialing';
  }

  function getFeatureLockPresentation(requiredPlan, options){
    var opts = options || {};
    return {
      eyebrow: 'Paid Feature',
      title: 'Subscribe to access ' + (opts.title || 'this feature'),
      body: opts.detail || 'Start your membership to unlock the full platform.',
      cta: 'Get Full Access — $25/month'
    };
  }

  return {
    formatBillingDate: formatBillingDate,
    normalizeSubscriptionStatus: normalizeSubscriptionStatus,
    getTrialDaysRemaining: getTrialDaysRemaining,
    getSubscriptionPresentation: getSubscriptionPresentation,
    getPricingPagePresentation: getPricingPagePresentation,
    canAccessFeature: canAccessFeature,
    getFeatureLockPresentation: getFeatureLockPresentation
  };
});
