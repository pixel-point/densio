# Paid Plan Input Duration Design

## Goal

Keep the Free plan's maximum input duration at 30 minutes and raise the maximum for Basic, Pro, and Scale to 180 minutes.

## Design

Add `maxVideoDurationSeconds` to each entry in the shared `PLAN_CATALOG`. The catalog will define 1,800 seconds for Free and 10,800 seconds for every paid plan.

API entitlement construction will copy the selected plan's duration limit from the catalog. Media inspection will continue enforcing the resolved entitlement, so inactive or absent paid access continues to receive Free limits through the existing entitlement-resolution path.

The capabilities response will advertise the same catalog value for the resolved plan. This keeps client discovery and server enforcement aligned without duplicating a free-versus-paid conditional.

## Error Handling

Inputs above the resolved plan limit will continue producing `DURATION_LIMIT_EXCEEDED`. The existing error message will report the applicable limit in seconds. Inputs exactly at the limit remain valid.

## Documentation

Update plan documentation and the bundled Densio skill error guidance to state that Free allows 30-minute inputs and paid plans allow 180-minute inputs.

## Testing

Tests will establish that:

- the shared catalog contains the expected per-plan duration limits;
- entitlement resolution gives Free 1,800 seconds and every paid plan 10,800 seconds;
- capabilities advertise 1,800 seconds for Free and 10,800 seconds for paid plans;
- media jobs reject Free inputs above 30 minutes and paid inputs above 180 minutes while accepting paid inputs between those limits.

Implementation will follow test-driven development: add assertions first, verify they fail for the missing paid-plan behavior, then update production policy and rerun focused and repository-wide checks.
