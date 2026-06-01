window.MP_BILLING = (function(){
  // Single plan — all paid users get full access
  var plans = [
    {
      id: 'pro',
      aliases: ['standard', 'basic'],
      name: 'Market Prism Full Access',
      priceId: 'price_1TEtLbPYE7k13i1ByCkSo2UR',
      priceLabel: '$25/mo',
      description: 'Full platform access — every tool, every signal, every ticker. Founding member rate locked for 12 months.',
      requiredRank: 1
    }
  ];

  var planRank = {
    none: 0,
    standard: 1,
    pro: 1,
    beta: 1
  };

  // Set to true to temporarily unlock all features for testing.
  // DISABLED — paywall is now enforced. Beta codes or paid subscription required.
  var dashboardAccessOverride = false;

  // Admin emails — always get full access regardless of subscription
  var adminEmails = ['tara@vtlbranding.com'];

  // No locked tabs — single tier means everything is unlocked for paid users
  var lockedTabs = {};

  function normalize(value){
    return String(value || '').trim().toLowerCase();
  }

  function getPlanByPriceId(priceId){
    var target = normalize(priceId);
    return plans.find(function(plan){
      return normalize(plan.priceId) === target;
    }) || null;
  }

  function inferPlan(planId, priceId){
    var direct = getPlanByPriceId(priceId);
    if(direct) return direct;
    var normalizedPlanId = normalize(planId);
    // Any paid plan maps to pro (full access)
    if(normalizedPlanId && normalizedPlanId !== 'none'){
      return plans[0];
    }
    return null;
  }

  function getPlanName(subscription){
    if(subscription && subscription.user_id === 'beta'){
      return 'Beta Access';
    }
    var plan = inferPlan(subscription && subscription.plan_id, subscription && subscription.price_id);
    return plan ? plan.name : 'No Active Plan';
  }

  function isAdmin(){
    try {
      var email = (window._mpCurrentUserEmail || '').toLowerCase().trim();
      return adminEmails.indexOf(email) !== -1;
    } catch(e) { return false; }
  }

  function getAccessLevel(subscription){
    if(dashboardAccessOverride || isAdmin()){
      return 'pro';
    }
    if(subscription && subscription.user_id === 'beta'){
      return 'pro';
    }
    var plan = inferPlan(subscription && subscription.plan_id, subscription && subscription.price_id);
    return plan ? 'pro' : 'none';
  }

  function hasAccess(subscription, requiredPlan){
    if(dashboardAccessOverride || isAdmin()){
      return true;
    }
    var status = normalize(subscription && subscription.status);
    if(['active', 'trialing'].indexOf(status) === -1){
      return false;
    }
    // Single tier — any active/trialing subscription has full access
    return true;
  }

  return {
    plans: plans,
    dashboardAccessOverride: dashboardAccessOverride,
    lockedTabs: lockedTabs,
    getPlanByPriceId: getPlanByPriceId,
    inferPlan: inferPlan,
    getPlanName: getPlanName,
    getAccessLevel: getAccessLevel,
    hasAccess: hasAccess
  };
})();
