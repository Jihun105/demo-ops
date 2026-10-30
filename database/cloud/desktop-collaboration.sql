begin;
-- Additional migration; the frozen schema-control release remains unchanged.
-- @include desktop/core.sql
-- @include desktop/role-features.sql
-- @include desktop/work-routes.sql
-- @include desktop/projections.sql
-- @include desktop/commands.sql
-- @include desktop/sales.sql
-- @include desktop/import.sql
-- @include desktop/billing.sql
-- @include desktop/earth.sql
-- @include desktop/upgrade-control.sql
-- @include privacy.sql
-- @include desktop/work-allocations.sql
-- @include desktop/assigned-work-reports.sql
-- @include desktop/work-progress.sql
-- @include desktop/work-origin.sql
-- @include desktop/cleanup.sql
-- @include desktop/roles.sql
-- @include desktop/registration-requests.sql
-- @include desktop/billing-claims.sql
-- @include desktop/phone-billing.sql
-- @include desktop/bank-claims.sql
grant execute on function demo_desktop.route_basis(uuid,uuid,integer,text),demo_desktop.route_plans(uuid,uuid) to demo_desktop_writer;
commit;
