// token 计费系统 —— 结构占位，暂不启用
// 说明：为「上市」预留计费结构，当前 BILLING_ENABLED=false，不影响现有 Agent 流程。
// 未来启用时，在 LLM 调用处（main.js chatCompletion / chatCompletionStream）调用 recordUsage 即可。

const BILLING_ENABLED = false;

/**
 * 计费数据模型
 * usage:  { userId, model, promptTokens, completionTokens, ts }
 * quota:  { userId, balance, plan }  // plan: 'free' | 'pro' | 'team'
 */

// 预留：用量记录点（启用后写入 userData/billing.json 或云端）
function recordUsage(usage) {
  if (!BILLING_ENABLED) return null;
  // TODO: 持久化用量记录，或上报云端
  return usage;
}

// 预留：余额/额度查询（当前返回占位）
function queryBilling(userId) {
  return {
    enabled: BILLING_ENABLED,
    userId: userId || null,
    plan: 'free',
    balance: 0,
    usage: [] // 启用后返回该用户用量统计
  };
}

module.exports = { recordUsage, queryBilling, BILLING_ENABLED };
