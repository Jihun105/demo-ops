'use strict';
const { parseDeposit, decideDeposit, currentWorkClaims } = require('../shared/bank-deposits.cjs');
const { claimsFromEvents, uuid } = require('../shared/field-model.cjs');
// Storage contract: context(scope,id,fingerprint), commit(scope,deposit,head,decision,manual).
// A different host/database implements this contract; matching rules stay unchanged.
function bankDepositService(repository, { now = () => new Date() } = {}) {
  const publicReceipt = (value, enabled) =>
    !enabled
      ? value
      : Object.fromEntries(
          ['id', 'amount', 'bank_at', 'received_at', 'status', 'claim_id', 'payment_id']
            .filter((key) => Object.hasOwn(value, key))
            .map((key) => [key, value[key]]),
        );
  async function process(scope, deposit, resolve) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const context = await repository.context(scope, deposit.id, deposit.fingerprint || null);
      if (!context) throw Error('회사 자료를 찾을 수 없습니다.');
      if (context.receipt && (!resolve || context.receipt.status !== 'held'))
        return publicReceipt(context.receipt, context.privacyEnabled);
      let decision;
      if (resolve) {
        // Shared companies confirm held deposits on the PC (청구·입금 → 확인 대기).
        if (Array.isArray(context.claims))
          throw Error('PC 청구·입금 화면의 확인 대기에서 확인해주세요.');
        const r = context.receipt;
        if (!r) throw Error('입금 문자를 찾을 수 없습니다.');
        deposit = {
          id: r.id,
          amount: r.amount,
          payer: r.payer,
          text: r.excerpt,
          receivedAt: r.received_at,
          bankAt: r.bank_at,
          fingerprint: r.fingerprint,
        };
        if (resolve.ignore) decision = { status: 'ignored', reason: '검토 후 제외', claimId: null };
        else {
          const claim = claimsFromEvents(context.events).find((c) => c.id === resolve.claimId);
          if (!currentWorkClaims(context.catalog, claim ? [claim] : [], now()).length)
            throw Error('올해 진행 작업에 연결된 발송 청구를 선택해주세요.');
          if (
            !claim?.sent ||
            !Number.isSafeInteger(deposit.amount) ||
            deposit.amount < 1 ||
            claim.balance < deposit.amount
          )
            throw Error('발송된 청구와 남은 금액을 다시 확인해주세요.');
          decision = { status: 'matched', reason: '검토 확인', claimId: claim.id };
        }
      } else decision = decideDeposit(deposit, context, now());
      const result = await repository.commit(scope, deposit, context.head, decision, !!resolve);
      if (!result.retry) return publicReceipt(result, context.privacyEnabled);
    }
    throw Error('청구 기록이 변경되고 있습니다. 잠시 후 다시 확인해주세요.');
  }
  return {
    async receive(scope, input) {
      const deposit = parseDeposit(input);
      return deposit
        ? process(scope, deposit)
        : { status: 'ignored', reason: '처리 대상 문자 아님' };
    },
    resolve(scope, id, claimId, ignore = false) {
      if (!uuid(id) || (!ignore && !uuid(claimId))) throw Error('확인할 청구를 선택해주세요.');
      return process(scope, { id }, { claimId, ignore });
    },
  };
}
module.exports = { bankDepositService };
