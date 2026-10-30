'use strict';
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const {
  seed,
  fixtureData,
  assertConnection,
  localClient,
  checked,
  createAccount,
  listLocalUsers,
  provision,
  addMembers,
} = require('./fixtures.cjs');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const { validateEvent, claimsFromEvents, uuid } = require('../../src/shared/field-model.cjs');
const { readBillingChanges } = require('../../src/shared/billing-reader.cjs');

function verificationFixture(workspaceId, now) {
  const fixture = fixtureData({ workspaceId, now });
  const claimTemplate = fixture.events[0];
  const sentTemplate = fixture.events[1];
  for (const [id, name] of [
    [2, '로컬 금액불일치'],
    [3, '로컬 동명이인'],
    [4, '로컬 동명이인'],
  ]) {
    const address = `로컬 테스트 구역 ${id}`;
    fixture.catalog.customers.push({
      id,
      name,
      phone: '01000000000',
      graves: [{ id, address, region: '가상 구역', payments: [] }],
    });
    const taskKey = 'annual:' + randomUUID();
    fixture.catalog.workRows.push({
      ...fixture.catalog.workRows[0],
      key: taskKey,
      customerId: id,
      graveId: id,
      address,
    });
    const claim = {
      ...claimTemplate,
      id: randomUUID(),
      payload: {
        ...claimTemplate.payload,
        taskKey,
        customerId: id,
        graveId: id,
        customerName: name,
        address,
      },
    };
    const sent = {
      ...sentTemplate,
      id: randomUUID(),
      payload: { claimId: claim.id, attemptId: randomUUID(), status: 'sent' },
    };
    fixture.events.push(validateEvent(claim, workspaceId), validateEvent(sent, workspaceId));
  }
  return fixture;
}

function receipt(now, payer, amount = 80000, id = randomUUID()) {
  const kst = new Date(now.getTime() + 9 * 3600000);
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${pad(kst.getUTCMonth() + 1)}/${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
  return {
    id,
    sender: '15882100',
    receivedAt: now.toISOString(),
    text: `농협 입금${amount.toLocaleString('en-US')}원 ${date} 123-45-****01 ${payer}`,
  };
}

async function receive(connection, token, input) {
  assertConnection(connection);
  const response = await fetch(`${connection.url}/functions/v1/bank-deposits`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/json',
      apikey: connection.anonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: 'receive', receipt: input }),
  });
  return { status: response.status, body: await response.json() };
}

function bounded(promise, message, milliseconds = 15000) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error(message)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function observeBilling(backend, access, afterRevision) {
  let readyResolve, readyReject, changedResolve, changedReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const changed = new Promise((resolve, reject) => {
    changedResolve = resolve;
    changedReject = reject;
  });
  // A subscription can fail before its caller reaches either await.
  ready.catch(() => {});
  changed.catch(() => {});
  const stop = backend.signals.watch(
    access,
    (row) => {
      if (
        row.owner_id === access.ownerId &&
        row.workspace_id === access.workspaceId &&
        row.kind === 'billing' &&
        Number(row.revision) > afterRevision
      )
        changedResolve(row);
    },
    (status, error) => {
      if (status === 'SUBSCRIBED') readyResolve();
      else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        const failure = Error(
          `로컬 Realtime 구독 실패: ${status}${error?.message ? ` (${error.message})` : ''}`,
        );
        readyReject(failure);
        changedReject(failure);
      }
    },
  );
  return {
    ready: () => bounded(ready, '로컬 Realtime 구독 제한 시간을 넘었습니다.'),
    changed: () => bounded(changed, '다른 로그인에서 billing 변경 알림을 받지 못했습니다.'),
    stop,
  };
}

async function scopedRows(client, table, ownerId, workspaceId) {
  return checked(
    await client.from(table).select('*').eq('owner_id', ownerId).eq('workspace_id', workspaceId),
    `${table} 로컬 권한 조회 실패`,
  );
}

async function verifyAccess(clients, backends, accounts, fixture, otherWorkspaceId) {
  const ownerId = accounts.owner.id;
  for (const role of ['owner', 'master']) {
    const access = checked(
      await backends[role].getDesktopAccess(fixture.workspaceId, ownerId),
      `${role} 회사 접근 실패`,
    );
    assert.equal(access.role, role);
    assert.equal(access.ownerId, ownerId);
    assert.equal(
      (await scopedRows(clients[role], 'demo_catalogs', ownerId, fixture.workspaceId)).length,
      1,
    );
    assert.equal(
      (await scopedRows(clients[role], 'demo_events', ownerId, fixture.workspaceId)).length,
      fixture.events.length,
    );
  }
  for (const role of ['worker', 'manager']) {
    const access = checked(
      await backends[role].getAccess(fixture.workspaceId),
      `${role} 역할 조회 실패`,
    );
    assert.equal(access.role, role);
    const scoped = checked(
      await clients[role].rpc('demo_worker_data', { p_workspace: fixture.workspaceId }),
      `${role} 작업 자료 조회 실패`,
    );
    assert.equal(scoped.catalog.customers.length, fixture.catalog.customers.length);
    assert.equal(
      scoped.catalog.customers[0].name,
      role === 'worker' ? '묘지 위치' : '로컬 가상고객',
    );
    assert.ok(
      scoped.catalog.customers.every((customer) =>
        customer.graves.every((grave) => !Object.hasOwn(grave, 'payments')),
      ),
    );
    assert.ok(
      (await backends[role].getDesktopAccess(fixture.workspaceId, ownerId)).error,
      `${role} 금융 접근이 차단되어야 합니다.`,
    );
    for (const table of ['demo_catalogs', 'demo_events', 'demo_sync_state', 'demo_sync_changes'])
      assert.deepEqual(
        await scopedRows(clients[role], table, ownerId, fixture.workspaceId),
        [],
        `${role}의 ${table} 금융 원본 접근`,
      );
    const write = await clients[role].from('demo_events').insert({
      owner_id: ownerId,
      workspace_id: fixture.workspaceId,
      id: randomUUID(),
      kind: 'payment_recorded',
      happened_at: new Date().toISOString(),
      payload: {
        claimId: fixture.claimId,
        amount: 1,
        payer: '로컬 테스트',
        note: '거절되어야 하는 가짜 기록',
      },
    });
    assert.ok(write.error, `${role} 금융 기록 쓰기가 차단되어야 합니다.`);
  }
  for (const role of ['owner', 'master', 'manager', 'worker']) {
    assert.ok(
      (await backends[role].getAccess(otherWorkspaceId)).error,
      `${role}의 다른 회사 접근이 차단되어야 합니다.`,
    );
    assert.deepEqual(
      await scopedRows(clients[role], 'demo_catalogs', accounts.otherOwner.id, otherWorkspaceId),
      [],
    );
  }
  assert.ok(
    (await backends.otherOwner.getAccess(fixture.workspaceId)).error,
    '다른 회사 사장님의 접근이 차단되어야 합니다.',
  );
  assert.deepEqual(
    await scopedRows(clients.otherOwner, 'demo_events', ownerId, fixture.workspaceId),
    [],
  );
}

async function cleanupWorkspace(connection, ownerId, workspaceId) {
  // IDs come only from this run's Auth creation and crypto.randomUUID, never from user input.
  const scope = `owner_id='${ownerId}'::uuid and workspace_id='${workspaceId}'::uuid`;
  await connection.executeSql(`begin;
delete from public.demo_members where ${scope};
delete from public.demo_bank_receipts where ${scope};
delete from public.demo_bank_devices where ${scope};
delete from public.demo_events where ${scope};
delete from public.demo_sync_changes where ${scope};
delete from public.demo_sync_state where ${scope};
delete from public.demo_catalogs where ${scope};
commit;`);
}

async function verify(connection) {
  assertConnection(connection);
  await seed(connection);
  const now = new Date();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const fixture = verificationFixture(workspaceId, now);
  const admin = localClient(connection, connection.serviceKey);
  const accounts = {},
    clients = {},
    backends = {};
  const workspaces = [];
  const attemptedEmails = new Set();
  const checks = [];
  let observer, failure, result;
  const passed = (name) => checks.push({ name, status: 'passed' });
  try {
    for (const [role, definition] of Object.entries(fixture.accounts)) {
      const email = `verify-${workspaceId}-${role.toLowerCase()}@demo.local.invalid`;
      attemptedEmails.add(email);
      accounts[role] = await createAccount(admin, {
        ...definition,
        email,
      });
      clients[role] = localClient(connection);
      const session = checked(
        await clients[role].auth.signInWithPassword({
          email: accounts[role].email,
          password: accounts[role].password,
        }),
        `${role} 실제 로그인 실패`,
      );
      assert.equal(session.user.id, accounts[role].id);
      assert.ok(session.session.access_token);
      backends[role] = supabaseBackend(clients[role], connection.url);
    }
    const rejected = localClient(connection);
    clients.badPassword = rejected;
    const wrongPassword = await rejected.auth.signInWithPassword({
      email: accounts.owner.email,
      password: `${accounts.owner.password}-wrong`,
    });
    assert.ok(wrongPassword.error, '잘못된 비밀번호는 거절되어야 합니다.');
    assert.equal(wrongPassword.error.code, 'invalid_credentials');
    assert.equal(wrongPassword.data.session, null);
    passed('auth-login-and-bad-password');

    // A SQL transport failure may arrive after commit, so cleanup is registered first.
    workspaces.push({ ownerId: accounts.owner.id, workspaceId });
    await provision(connection, accounts.owner.id, workspaceId);
    workspaces.push({ ownerId: accounts.otherOwner.id, workspaceId: otherWorkspaceId });
    await provision(connection, accounts.otherOwner.id, otherWorkspaceId);
    await addMembers(admin, accounts, accounts.owner.id, workspaceId);
    await backends.owner.records(accounts.owner.id).publish(fixture.catalog);
    await backends.owner.records(accounts.owner.id).push(fixture.events);
    const otherFixture = fixtureData({ workspaceId: otherWorkspaceId, now });
    otherFixture.catalog.customers[0].name = '로컬 다른회사 고객';
    await backends.otherOwner.records(accounts.otherOwner.id).publish(otherFixture.catalog);
    await verifyAccess(clients, backends, accounts, fixture, otherWorkspaceId);
    passed('owner-and-master-company-access');
    passed('worker-and-manager-finance-denied-with-scoped-work-data');
    passed('cross-workspace-access-denied');

    const input = receipt(now, '로컬 가상고객');
    const unknownToken = `demo_bank_${randomBytes(32).toString('hex')}`;
    const unknown = await receive(connection, unknownToken, input);
    assert.equal(unknown.status, 403, '미등록 수신 기기는 HTTP에서 거절되어야 합니다.');
    passed('unregistered-device-denied');
    const token = `demo_bank_${randomBytes(32).toString('hex')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    checked(
      await backends.owner.deposits.register(workspaceId, hash, false),
      '가짜 은행 수신 기기 등록 실패',
    );

    const access = { ownerId: accounts.owner.id, workspaceId, role: 'master' };
    const signals = checked(await backends.master.signals.read(access), 'billing 신호 조회 실패');
    const revision = Number(signals.find((row) => row.kind === 'billing')?.revision || 0);
    observer = observeBilling(backends.master, access, revision);
    await observer.ready();
    const matched = await receive(connection, token, input);
    assert.equal(matched.status, 200);
    assert.deepEqual(matched.body, { id: input.id, status: 'matched' });
    passed('exact-80000-receipt-matched');
    await observer.changed();
    const billing = await readBillingChanges(
      backends.master.records(accounts.owner.id),
      workspaceId,
      null,
    );
    const claim = claimsFromEvents(billing.events).find((item) => item.id === fixture.claimId);
    assert.equal(claim.paidAmount, 80000);
    assert.equal(claim.balance, 0);
    passed('cross-login-realtime-billing-signal-and-read');

    const retry = await receive(connection, token, input);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, matched.body);
    passed('duplicate-receipt-id-does-not-add-payment');
    const fingerprint = await receive(connection, token, { ...input, id: randomUUID() });
    assert.equal(fingerprint.status, 200);
    assert.equal(fingerprint.body.status, 'held');
    passed('duplicate-fingerprint-held-without-payment');
    const mismatch = await receive(connection, token, receipt(now, '로컬 금액불일치', 70000));
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.body.status, 'held');
    passed('amount-mismatch-held');
    const ambiguous = await receive(connection, token, receipt(now, '로컬 동명이인'));
    assert.equal(ambiguous.status, 200);
    assert.equal(ambiguous.body.status, 'held');
    passed('ambiguous-customer-held');

    const events = await scopedRows(clients.owner, 'demo_events', accounts.owner.id, workspaceId);
    const payments = events.filter((event) => event.kind === 'payment_recorded');
    assert.equal(payments.length, 1, '재전송·보류 요청이 입금을 추가하면 안 됩니다.');
    assert.equal(payments[0].payload.amount, 80000);
    const receipts = await scopedRows(
      clients.master,
      'demo_bank_receipts',
      accounts.owner.id,
      workspaceId,
    );
    assert.equal(receipts.length, 4);
    assert.equal(receipts.filter((row) => row.status === 'matched').length, 1);
    for (const role of ['worker', 'manager']) {
      assert.deepEqual(
        await scopedRows(clients[role], 'demo_bank_receipts', accounts.owner.id, workspaceId),
        [],
      );
      const signals = checked(
        await backends[role].signals.read(access),
        `${role} 변경 신호 조회 실패`,
      );
      assert.equal(
        signals.some((row) => row.kind === 'billing'),
        false,
      );
    }
    checked(
      await backends.owner.deposits.revoke(workspaceId, hash),
      '가짜 은행 수신 기기 해제 실패',
    );
    const revoked = await receive(connection, token, receipt(now, '로컬 가상고객'));
    assert.equal(revoked.status, 403, '해제된 수신 기기는 HTTP에서 거절되어야 합니다.');
    passed('revoked-device-denied');
    result = {
      passed: checks.length,
      checks,
      matchedAmount: 80000,
      paymentCount: 1,
      heldReceipts: 3,
    };
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    const clean = async (action) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (observer) await clean(() => observer.stop());
    for (const client of Object.values(clients)) {
      await clean(() => client.removeAllChannels());
      await clean(async () =>
        checked(await client.auth.signOut({ scope: 'local' }), '가짜 로그인 정리 실패'),
      );
      client.auth.stopAutoRefresh();
    }
    for (const workspace of workspaces.reverse())
      await clean(() => cleanupWorkspace(connection, workspace.ownerId, workspace.workspaceId));
    const knownEmails = new Set(Object.values(accounts).map((account) => account.email));
    const uncertainEmails = [...attemptedEmails].filter((email) => !knownEmails.has(email));
    if (uncertainEmails.length)
      await clean(async () => {
        // Recover a committed Auth creation whose response was lost; never sweep older runs.
        const users = await listLocalUsers(admin);
        for (const email of uncertainEmails) {
          const user = users.get(email);
          if (!user) continue;
          if (!uuid(user.id) || user.user_metadata?.demo_local_fixture !== true)
            throw Error('응답이 유실된 가짜 계정의 테스트 전용 표시를 확인해주세요.');
          accounts[`recovered-${user.id}`] = { id: user.id, email };
        }
      });
    for (const account of Object.values(accounts).reverse())
      await clean(async () =>
        checked(await admin.auth.admin.deleteUser(account.id), '임시 가짜 계정 정리 실패'),
      );
    admin.auth.stopAutoRefresh();
    if (cleanupErrors.length)
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        '로컬 검증 중 임시 자료 정리에 실패했습니다. local:reset으로 이 테스트 환경만 다시 만들 수 있습니다.',
      );
  }
  if (failure) throw failure;
  return result;
}

module.exports = { verify };
