const { checkStatus } = require('./sync.cjs');
const { mergeEvents } = require('./field-model.cjs');
async function readBillingChanges(transport, workspace, checkpoint) {
  if (checkpoint?.protocol === 2)
    throw Error('전환된 회사의 회계 자료는 제한 조회로 확인해주세요.');
  const status = checkStatus(await transport.status(workspace), workspace);
  if (!status) return { events: [], checkpoint: null };
  const cursor =
    checkpoint?.generation === status.generation &&
    Number.isSafeInteger(checkpoint.cursor) &&
    checkpoint.cursor >= 0 &&
    checkpoint.cursor <= status.head
      ? checkpoint.cursor
      : 0;
  const changes =
    cursor < status.head ? await transport.pull(workspace, cursor, status.head, true) : [];
  if (changes.some((row) => row.kind !== 'event'))
    throw Error('업무 기록 형식이 올바르지 않습니다.');
  return {
    events: mergeEvents(
      [],
      changes.map((row) => row.value),
      workspace,
    ),
    checkpoint: { generation: status.generation, cursor: status.head },
  };
}
module.exports = { readBillingChanges };
