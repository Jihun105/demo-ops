const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { scratch } = require('../helpers/temp-dir.cjs');
const { desktopScreen } = require('../helpers/dom.cjs');
function screen(t, request) {
  const { w, d } = desktopScreen(t, {
    visible: true,
    dialogs: true,
    scripts: ['model.js', 'sales-assignment.js'],
  });
  return {
    w,
    d,
    ui: w.demoSalesAssignment.create({ connectionId: 'fake', year: 2026, request }),
  };
}
const row = {
  customerId: 1,
  graveId: 11,
  name: '가짜 배정 고객',
  phone: '01000000000',
  address: '가짜 주소',
  region: '가평',
  notes: '',
  requirements: '',
  deadline: '',
  currentAmount: '',
  previousAmount: '',
  revision: 'customer:1:1',
};
const lease = {
  customerId: 1,
  token: 'fake',
  state: 'active',
  lastSeenAt: new Date().toISOString(),
};
const { waitFor } = require('../helpers/wait-for.cjs');
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function sharedScreen(t, { salesDelay, transport } = {}) {
  const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
  const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');
  const { draftStore } = require('../../src/desktop/shared-desktop/shared-drafts.cjs');
  const { salesSession } = require('../../src/desktop/work/sales-session.cjs');
  const c = await setupSharedDatabase(t);
  const userData = scratch(t, 'sales-ui-regression-');
  const wrap = async (name, args) => {
    try {
      return { data: await rpc(c.db, name, args) };
    } catch (e) {
      return { error: { code: e.hint || e.code, message: e.message } };
    }
  };
  const service = sharedDesktop({
    userData,
    access: { role: 'owner', actorId: c.owner, ownerId: c.owner, workspaceId: c.ws },
    current: () => true,
    api: {
      read: (ws) => wrap('demo_desktop_read', [ws]),
      command: (ws, sid, rid, input) => wrap('demo_desktop_command', [ws, sid, rid, input]),
      result: (ws, rid) => wrap('demo_desktop_result', [ws, rid]),
      sales: async (ws, sid, input) => {
        await salesDelay?.('before', input);
        const result = await wrap('demo_sales_assignment', [ws, sid, input]);
        await salesDelay?.('after', input);
        return result;
      },
    },
  });
  await service.refresh();
  const drafts = draftStore(userData, service.access);
  const session = salesSession({ service, drafts, current: () => true });
  const page = screen(t, async (p) => {
    try {
      let result;
      if (p.action === 'regions') result = await session.regions(p.year);
      else if (p.action === 'draft') {
        session.draft(p.value, { customerId: p.customerId, revision: p.revision });
        result = {};
      } else if (p.action === 'save') {
        const saved = await session.save(p);
        result = {
          ok: saved.state === 'committed',
          saveState: saved.state,
          code: saved.error?.code,
          message: saved.error?.message,
          ...saved.result,
        };
      } else result = await session[p.action](p);
      const serialized = JSON.parse(JSON.stringify({ ok: true, ...result }));
      return transport ? transport(p, serialized) : serialized;
    } catch (e) {
      return { ok: false, code: e.code, message: e.message };
    }
  });
  t.after(() => page.ui.dispose());
  return { ...c, ...page, service, drafts, session };
}
test('a live sales lease keeps keyboard navigation in the visible work-tab order', async (t) => {
  for (const [selected, key, target] of [
    ['sales', 'End', 'distribute'],
    ['manage', 'ArrowRight', 'check'],
  ]) {
    await t.test(key + ' from ' + selected, async (t) => {
      const { w, d, ui } = screen(t, async (input) =>
        input.action === 'release'
          ? { ok: true, released: true }
          : { ok: true, row, lease, confirmed: true },
      );
      await ui.claim({ region: '*' });
      let opened;
      for (const name of ['sales', 'manage', 'check', 'distribute']) {
        const button = d.getElementById('work-tab-' + name);
        button.setAttribute('aria-selected', String(name === selected));
        button.onclick = () => {
          opened = name;
        };
      }
      d.getElementById('work-tabs').dispatchEvent(
        new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      await require('../helpers/wait-for.cjs').waitFor(
        () => d.getElementById('sales-ended-dialog').open,
        'call-end confirmation',
      );
      d.getElementById('sales-ended-discard').click();
      await require('../helpers/wait-for.cjs').waitFor(() => !!opened, 'target work tab opened');
      assert.equal(opened, target);
      ui.dispose();
    });
  }
});
test('phone card stays hidden before claim and confirmation loss disables controls while retaining input', async (t) => {
  let fail = false;
  const calls = [];
  const { d, ui } = screen(t, async (input) => {
    calls.push(input);
    if (input.action === 'regions')
      return { ok: true, regions: [{ region: '가평', availableCount: 1 }] };
    if (fail) throw Error('fake lost confirmation');
    return {
      ok: true,
      row,
      lease,
      confirmed: true,
      value: input.action === 'draft' ? input.value : undefined,
    };
  });
  await ui.start();
  assert.equal(d.getElementById('work-sales-card').hidden, true);
  await ui.claim({ region: '*' });
  assert.equal(d.getElementById('work-sales-card').hidden, false);
  assert.equal(
    d.getElementById('work-sales-next-preview').textContent,
    '다음 고객은 배정받은 뒤 표시됩니다.',
  );
  d.getElementById('work-sales-notes').value = '가짜 입력';
  fail = true;
  await ui.heartbeat();
  assert.equal(d.getElementById('work-sales-save-next').disabled, true);
  assert.equal(d.getElementById('work-sales-notes').value, '가짜 입력');
  assert.equal(d.getElementById('work-sales-phone').textContent.includes('01000000000'), false);
  ui.dispose();
});
test('late claim is ignored after disposal and save success followed by claim failure keeps an accurate blank card', async (t) => {
  let resolve;
  const { d, ui } = screen(t, async (input) => {
    if (input.action === 'regions') return { ok: true, regions: [] };
    return new Promise((r) => (resolve = r));
  });
  const p = ui.claim({ region: '*' });
  ui.dispose();
  resolve({ ok: true, row, lease, confirmed: true });
  await p;
  assert.equal(d.getElementById('work-sales-card').hidden, true);
});
test('region navigation waits for ended-call confirmation; a committed save survives next-claim failure', async (t) => {
  let claims = 0,
    releases = 0;
  const { d, ui } = screen(t, async (input) => {
    if (input.action === 'regions')
      return { ok: true, regions: [{ region: '가평', availableCount: 2 }] };
    if (input.action === 'release') {
      releases++;
      return { ok: true, released: true };
    }
    if (input.action === 'save') return { ok: true, saveState: 'committed' };
    if (input.action === 'claim') {
      claims++;
      if (claims > 1) throw Error('fake next assignment failure');
      return { ok: true, row, lease, confirmed: true };
    }
  });
  await ui.start();
  await ui.claim({ region: '*' });
  const select = d.getElementById('work-sales-region');
  select.value = '가평';
  select.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(releases, 0);
  assert.equal(d.getElementById('sales-ended-dialog').open, true);
  assert.equal(d.getElementById('sales-ended-discard').disabled, false);
  d.getElementById('sales-ended-cancel').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(releases, 0);
  d.querySelector('[data-window="close"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(d.getElementById('sales-ended-dialog').open, true);
  d.getElementById('sales-ended-cancel').click();
  await new Promise((r) => setTimeout(r, 0));
  await ui.save({ confirmedEnded: true });
  assert.equal(d.getElementById('work-sales-card').hidden, true);
  assert.match(d.getElementById('work-status').textContent, /저장했습니다/);
  ui.dispose();
});

test('with no assigned customer the check is skipped and no warning appears', async (t) => {
  const calls = [];
  const { d, ui } = screen(t, async (p) => {
    calls.push(p.action);
    if (p.action === 'regions') return { ok: true, regions: [] };
    return { ok: true, row: null, lease: null, confirmed: false };
  });
  await ui.heartbeat();
  await ui.heartbeat(true);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(d.getElementById('work-status').textContent, /배정 확인/);
  await ui.claim({ region: '*' });
  assert.match(d.getElementById('work-sales-empty-title').textContent, /배정할 고객이 없습니다/);
  await ui.heartbeat();
  assert.deepEqual(calls, ['claim']);
  assert.equal(d.getElementById('work-status').textContent, '');
  ui.dispose();
});

test('after a lost claim response, pressing claim again shows the assigned customer', async (t) => {
  let lost = true;
  const { d, ui } = screen(t, async (p) => {
    if (p.action === 'regions') return { ok: true, regions: [] };
    if (p.action === 'claim' && lost) {
      lost = false;
      throw Error('lost claim');
    }
    return { ok: true, row, lease, confirmed: true, value: { notes: '복원 메모' } };
  });
  await ui.claim({ region: '*' });
  assert.equal(d.getElementById('work-sales-card').hidden, true);
  await ui.claim({ region: '*' });
  assert.equal(d.getElementById('work-sales-card').hidden, false);
  assert.equal(d.getElementById('work-sales-notes').value, '복원 메모');
  ui.dispose();
});

test('shared name search waits for call-end confirmation, preserves cancellation and filters subsequent navigation', async (t) => {
  const calls = [];
  const { d, w, ui } = screen(t, async (input) => {
    calls.push(input);
    if (input.action === 'regions')
      return { ok: true, regions: [{ region: '가평', availableCount: 2 }] };
    if (input.action === 'release') return { ok: true, released: true };
    return { ok: true, row, lease, confirmed: true };
  });
  await ui.start();
  const search = d.getElementById('work-sales-search');
  search.value = '가짜';
  d.getElementById('work-sales-search-form').dispatchEvent(
    new w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.at(-1).action, 'claim');
  assert.equal(calls.at(-1).nameQuery, '가짜');
  assert.equal(calls.at(-1).region, '*');
  search.value = '다른';
  d.getElementById('work-sales-search-form').dispatchEvent(
    new w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(d.getElementById('sales-ended-dialog').open, true);
  d.getElementById('sales-ended-cancel').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(search.value, '가짜');
  assert.equal(calls.filter((c) => c.action === 'claim').length, 1);
  d.getElementById('work-sales-next').click();
  await new Promise((r) => setTimeout(r, 0));
  d.getElementById('sales-ended-discard').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.at(-1).nameQuery, '가짜');
  ui.dispose();
});

test('배정 고객 이동은 체크 없이 버리기·취소만 고르고 통화 종료를 서버에 전달한다', async (t) => {
  for (const choice of ['discard', 'cancel']) {
    await t.test(choice, async (t) => {
      const calls = [];
      const { d, ui } = screen(t, async (input) => {
        calls.push(input);
        if (input.action === 'release') return { ok: true, released: true };
        if (input.action === 'save') return { ok: true, saveState: 'committed' };
        return { ok: true, row, lease, confirmed: true };
      });
      await ui.claim({ region: '*' });
      d.getElementById('work-sales-notes').value = '보존할 입력';
      let moved = false;
      const pending = ui.move(() => {
        moved = true;
      });
      await require('../helpers/wait-for.cjs').waitFor(
        () => d.getElementById('sales-ended-dialog').open,
        '이동 선택 창',
      );
      assert.equal(d.querySelector('#sales-ended-dialog input[type="checkbox"]'), null);
      assert.equal(d.getElementById('sales-ended-save').hidden, true);
      const button = d.getElementById('sales-ended-' + choice);
      assert.equal(button.disabled, false);
      button.click();
      await pending;
      assert.equal(moved, choice !== 'cancel');
      const write = calls.find((c) => ['save', 'release'].includes(c.action));
      if (choice === 'cancel') {
        assert.equal(write, undefined);
        assert.equal(d.getElementById('work-sales-notes').value, '보존할 입력');
      } else {
        assert.equal(write.action, 'release');
        assert.equal(write.confirmedEnded, true);
      }
      ui.dispose();
    });
  }
});

test('resuming a prior-year draft uses its year for labels and the actual save, then returns to the default claim year', async (t) => {
  const c = await sharedScreen(t);
  const previous = await c.session.claim({ year: 2025, region: '*' });
  c.session.draft({ ...previous.row, notes: '전년도 초안' });
  await c.db.exec(
    "update demo_desktop.sales_assignments set last_seen_at=clock_timestamp()-interval '91 seconds'",
  );
  await c.ui.review();
  [...c.d.querySelectorAll('#sales-review-list button')]
    .find((button) => button.textContent === '내 초안 이어가기')
    .click();
  await waitFor(() => c.ui.view().confirmed, 'prior-year draft resumed');
  const labels = [
    c.d.getElementById('work-sales-previous-label').textContent,
    c.d.getElementById('work-sales-current-label').textContent,
  ];
  const saved = await c.ui.save({ confirmedEnded: true, advance: false });
  assert.equal(saved, true);
  assert.deepEqual(labels, ['전년도 금액 (2024)', '올해 금액 (2025)']);
  assert.equal(
    (
      await c.db.query('select year from demo_desktop.annual_work where customer_id=$1', [
        previous.row.customerId,
      ])
    ).rows[0].year,
    2025,
  );
  await c.ui.claim({ region: '*' });
  assert.equal(c.ui.view().year, 2026);
  assert.equal(c.d.getElementById('work-sales-current-label').textContent, '올해 금액 (2026)');
});

test('a delayed serialized heartbeat cannot replace newer durable input before refresh and save', async (t) => {
  const captured = deferred(),
    delivery = deferred();
  const c = await sharedScreen(t, {
    transport: async (input, result) => {
      if (input.action === 'heartbeat') {
        captured.resolve();
        await delivery.promise;
      }
      return result;
    },
  });
  await c.ui.claim({ region: '*' });
  const customerId = c.ui.view().row.customerId;
  const pending = c.ui.heartbeat();
  await captured.promise;
  const notes = c.d.getElementById('work-sales-notes');
  notes.value = '마지막으로 작성한 메모';
  notes.dispatchEvent(new c.w.Event('input', { bubbles: true }));
  await waitFor(
    () => c.drafts.read('sales:' + customerId)?.value.notes === '마지막으로 작성한 메모',
    'latest input persisted',
  );
  delivery.resolve();
  await pending;
  await c.ui.start();
  const visible = notes.value;
  assert.equal(await c.ui.save({ confirmedEnded: true, advance: false }), true);
  const saved = (
    await c.db.query(
      "select data->>'special_notes' notes from demo_desktop.customers where id=$1",
      [customerId],
    )
  ).rows[0].notes;
  assert.deepEqual(
    { visible, saved },
    { visible: '마지막으로 작성한 메모', saved: '마지막으로 작성한 메모' },
  );
});

test('reviewing a conflict updates the session draft revision and survives heartbeat before retry', async (t) => {
  const c = await sharedScreen(t);
  c.w.demoSharedSave = {
    submit: ({ input, invoke }) => invoke(input),
    reviewConflict: async () => true,
  };
  c.w.demo = {
    readDraft() {},
    async getCustomerDetail(input) {
      await c.service.refresh();
      return {
        ok: true,
        detail: require('../../src/desktop/shared-desktop/shared-view.cjs').customerDetail(
          c.service.snapshot(),
          input,
        ),
      };
    },
  };
  await c.ui.claim({ region: '*' });
  const target = c.ui.view().row;
  const notes = c.d.getElementById('work-sales-notes');
  notes.value = '충돌 검토 후 저장할 메모';
  notes.dispatchEvent(new c.w.Event('input', { bubbles: true }));
  await c.db.query('select demo_desktop.bump($1,$2,$3,$4)', [
    c.owner,
    c.ws,
    target.customerId,
    target.graveId,
  ]);
  assert.equal(await c.ui.save({ confirmedEnded: true, advance: false }), false);
  const reviewedRevision = c.ui.view().row.revision;
  assert.notEqual(reviewedRevision, target.revision);
  await c.ui.heartbeat();
  assert.equal(c.ui.view().row.revision, reviewedRevision);
  assert.equal(c.drafts.read('sales:' + target.customerId).row.revision, reviewedRevision);
  assert.equal(await c.ui.save({ confirmedEnded: true, advance: false }), true);
  assert.equal(
    (
      await c.db.query(
        "select data->>'special_notes' notes from demo_desktop.customers where id=$1",
        [target.customerId],
      )
    ).rows[0].notes,
    '충돌 검토 후 저장할 메모',
  );
});

test('discard navigation locks editing throughout release before SQL and after the SQL response', async (t) => {
  for (const delayedPhase of ['before', 'after']) {
    await t.test(delayedPhase, async (t) => {
      const entered = deferred(),
        finish = deferred();
      const c = await sharedScreen(t, {
        salesDelay: async (phase, input) => {
          if (phase === delayedPhase && input.action === 'release') {
            entered.resolve();
            await finish.promise;
          }
        },
      });
      await c.ui.claim({ region: '*' });
      const customerId = c.ui.view().row.customerId;
      const pending = c.ui.move(() => c.ui.claim({ region: '*', afterCustomerId: customerId }));
      await waitFor(() => c.d.getElementById('sales-ended-dialog').open, 'discard confirmation');
      c.d.getElementById('sales-ended-discard').click();
      await entered.promise;
      const locked = [
        ...c.d.querySelectorAll(
          '#work-sales-form input,#work-sales-form textarea,#work-sales-form button',
        ),
      ].every((el) => el.disabled);
      const serverState = (
        await c.db.query('select state from demo_desktop.sales_assignments where customer_id=$1', [
          customerId,
        ])
      ).rows[0].state;
      finish.resolve();
      await pending;
      assert.equal(serverState, delayedPhase === 'before' ? 'active' : 'released');
      assert.equal(locked, true);
      assert.notEqual(c.ui.view().row.customerId, customerId);
    });
  }
});

test('a failed release keeps typed input and unlocks retry without duplicate movement', async (t) => {
  const entered = deferred(),
    finish = deferred();
  let releases = 0;
  const { d, w, ui } = screen(t, async (input) => {
    if (input.action === 'release') {
      releases++;
      entered.resolve();
      await finish.promise;
      return { ok: false, message: '해제 응답을 받지 못했습니다.' };
    }
    return { ok: true, row, lease, confirmed: true };
  });
  await ui.claim({ region: '*' });
  const notes = d.getElementById('work-sales-notes');
  notes.value = '실패 후 보존할 메모';
  notes.dispatchEvent(new w.Event('input', { bubbles: true }));
  let moved = false;
  const pending = ui.move(() => {
    moved = true;
  });
  await waitFor(() => d.getElementById('sales-ended-dialog').open, 'discard confirmation');
  d.getElementById('sales-ended-discard').click();
  await entered.promise;
  const locked = notes.disabled;
  await ui.move(() => {
    moved = true;
  });
  finish.resolve();
  await pending;
  assert.deepEqual(
    { locked, moved, releases, notes: notes.value },
    { locked: true, moved: false, releases: 1, notes: '실패 후 보존할 메모' },
  );
  assert.equal(notes.disabled, false);
  ui.dispose();
});

test('a resume in progress locks the form and ignores repeated resume clicks', async (t) => {
  const entered = deferred(),
    finish = deferred();
  let resumes = 0;
  const { d, ui } = screen(t, async (input) => {
    if (input.action === 'review')
      return { ok: true, rows: [{ ...row, canResume: true, lastSeenAt: lease.lastSeenAt }] };
    if (input.action === 'resume') {
      resumes++;
      entered.resolve();
      await finish.promise;
    }
    return { ok: true, row, lease, confirmed: true, year: 2026 };
  });
  await ui.claim({ region: '*' });
  await ui.review();
  const resume = [...d.querySelectorAll('#sales-review-list button')].find(
    (button) => button.textContent === '내 초안 이어가기',
  );
  resume.click();
  await entered.promise;
  resume.click();
  const locked = d.getElementById('work-sales-notes').disabled;
  finish.resolve();
  await waitFor(() => !d.getElementById('sales-review-dialog').open, 'resume completed');
  assert.deepEqual({ resumes, locked }, { resumes: 1, locked: true });
  ui.dispose();
});

test('an externally released assignment keeps local input visible across rechecks and allows the next claim', async (t) => {
  const c = await sharedScreen(t);
  await c.ui.claim({ region: '*' });
  const customerId = c.ui.view().row.customerId;
  const notes = c.d.getElementById('work-sales-notes');
  notes.value = '해제된 고객의 보존할 메모';
  notes.dispatchEvent(new c.w.Event('input', { bubbles: true }));
  await waitFor(
    () => c.drafts.read('sales:' + customerId)?.value.notes === notes.value,
    'draft saved',
  );
  await c.service.sales(require('node:crypto').randomUUID(), {
    action: 'admin-release',
    customerId,
    reason: '통화 종료 확인',
  });
  await c.ui.heartbeat();
  await c.ui.heartbeat();
  assert.equal(notes.value, '해제된 고객의 보존할 메모');
  assert.equal(notes.disabled, true);
  assert.equal(c.ui.view().lease, null);
  const canceled = c.ui.move(() => c.ui.claim({ region: '*', afterCustomerId: customerId }));
  await waitFor(
    () => c.d.getElementById('sales-ended-dialog').open,
    'lost-input discard confirmation',
  );
  assert.equal(c.d.getElementById('sales-ended-save').hidden, true, 'moving never saves');
  c.d.getElementById('sales-ended-cancel').click();
  await canceled;
  assert.equal(notes.value, '해제된 고객의 보존할 메모');
  assert.equal(c.drafts.read('sales:' + customerId).value.notes, '해제된 고객의 보존할 메모');
  const next = c.ui.move(() => c.ui.claim({ region: '*', afterCustomerId: customerId }));
  await waitFor(() => c.d.getElementById('sales-ended-dialog').open, 'explicit discard');
  c.d.getElementById('sales-ended-discard').click();
  await next;
  assert.notEqual(c.ui.view().row.customerId, customerId);
  assert.equal(c.drafts.read('sales:' + customerId), null);
});

test('a visible resume control cannot rotate a lease while discard release is pending', async (t) => {
  const entered = deferred(),
    finish = deferred();
  let resumes = 0,
    reviews = 0;
  const { d, ui } = screen(t, async (input) => {
    if (input.action === 'heartbeat')
      return { ok: true, row, lease: { ...lease, state: 'needs_review' }, confirmed: false };
    if (input.action === 'resume') resumes++;
    if (input.action === 'review') {
      reviews++;
      return { ok: true, rows: [] };
    }
    if (input.action === 'release') {
      entered.resolve();
      await finish.promise;
      return { ok: true, released: true };
    }
    return { ok: true, row, lease, confirmed: true };
  });
  await ui.claim({ region: '*' });
  await ui.heartbeat();
  const resume = d.getElementById('work-sales-resume');
  assert.equal(resume.hidden, false);
  const pending = ui.move(() => {});
  await waitFor(() => d.getElementById('sales-ended-dialog').open, 'discard confirmation');
  d.getElementById('sales-ended-discard').click();
  await entered.promise;
  const locked = resume.disabled && d.getElementById('work-sales-review').disabled;
  resume.click();
  d.getElementById('work-sales-review').click();
  finish.resolve();
  await pending;
  assert.deepEqual({ locked, resumes, reviews }, { locked: true, resumes: 0, reviews: 0 });
  ui.dispose();
});

test('saving waits for every consecutive input draft and commits the last typed value', async (t) => {
  const entered = deferred(),
    finish = deferred();
  let first = true;
  const c = await sharedScreen(t, {
    transport: async (input, result) => {
      if (input.action === 'draft' && first) {
        first = false;
        entered.resolve();
        await finish.promise;
      }
      return result;
    },
  });
  await c.ui.claim({ region: '*' });
  const customerId = c.ui.view().row.customerId;
  const notes = c.d.getElementById('work-sales-notes');
  notes.value = '첫 입력';
  notes.dispatchEvent(new c.w.Event('input', { bubbles: true }));
  await entered.promise;
  notes.value = '연속 입력의 마지막 메모';
  notes.dispatchEvent(new c.w.Event('input', { bubbles: true }));
  const saving = c.ui.save();
  await waitFor(() => c.d.getElementById('sales-ended-dialog').open, 'save confirmation');
  assert.equal(notes.disabled, true);
  c.d.getElementById('sales-ended-save').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    (
      await c.db.query(
        "select data->>'special_notes' notes from demo_desktop.customers where id=$1",
        [customerId],
      )
    ).rows[0].notes,
    null,
  );
  finish.resolve();
  assert.equal(await saving, true);
  assert.equal(
    (
      await c.db.query(
        "select data->>'special_notes' notes from demo_desktop.customers where id=$1",
        [customerId],
      )
    ).rows[0].notes,
    '연속 입력의 마지막 메모',
  );
});

test('confirmation loss while the save dialog is open prevents a write and retains input', async (t) => {
  let saves = 0;
  const { d, w, ui } = screen(t, async (input) => {
    if (input.action === 'save') saves++;
    return { ok: true, row, lease, confirmed: true };
  });
  await ui.claim({ region: '*' });
  const notes = d.getElementById('work-sales-notes');
  notes.value = '확인창에서 보존할 입력';
  notes.dispatchEvent(new w.Event('input', { bubbles: true }));
  const pending = ui.save();
  await waitFor(() => d.getElementById('sales-ended-dialog').open, 'save confirmation');
  d.dispatchEvent(new w.Event('visibilitychange'));
  d.getElementById('sales-ended-save').click();
  assert.equal(await pending, false);
  assert.equal(saves, 0);
  assert.equal(notes.value, '확인창에서 보존할 입력');
  assert.equal(notes.disabled, true);
  ui.dispose();
});

test('overlapping heartbeat checks can confirm a lease before the later check finishes', async (t) => {
  const first = deferred(),
    second = deferred();
  let checks = 0;
  const { ui } = screen(t, async (input) => {
    if (input.action === 'heartbeat') {
      checks++;
      await (checks === 1 ? first.promise : second.promise);
    }
    return { ok: true, row, lease, confirmed: input.action !== 'claim' };
  });
  await ui.claim({ region: '*' });
  const earlier = ui.heartbeat(),
    later = ui.heartbeat();
  first.resolve();
  await earlier;
  const confirmedBeforeLaterFinishes = ui.view().confirmed;
  second.resolve();
  await later;
  assert.equal(confirmedBeforeLaterFinishes, true);
  ui.dispose();
});

test('전화 결과는 진행·미진행·연락 X 순서이고 새 고객은 진행이 골라져 있다', async (t) => {
  const { d, ui } = screen(t, async (p) =>
    p.action === 'regions' ? { ok: true, regions: [] } : { ok: true, row, lease, confirmed: true },
  );
  assert.deepEqual(
    [...d.querySelectorAll('input[name="sales-status"]')].map((e) => e.value),
    ['proceed', 'declined', 'uncontacted'],
  );
  await ui.claim({ region: '*' });
  assert.equal(d.querySelector('input[name="sales-status"]:checked').value, 'proceed');
  assert.equal(d.getElementById('work-status').textContent, '');
  ui.dispose();
});

test('영업 확인의 전화번호는 010-1234-5678 형태로 보인다', async (t) => {
  const { d, ui } = screen(t, async (p) =>
    p.action === 'regions'
      ? { ok: true, regions: [] }
      : { ok: true, row: { ...row, phone: '01012345678' }, lease, confirmed: true },
  );
  await ui.claim({ region: '*' });
  assert.equal(d.getElementById('work-sales-phone').textContent, '010-1234-5678');
  ui.dispose();
});
