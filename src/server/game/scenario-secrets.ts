/**
 * Server-only scenario truth for Operation Nightfall (fictional: Meridian Cloud).
 *
 * Import this only from worker-side code (src/actions, src/server). Nothing
 * under src/pages or src/game may import it: text here reaches a player only
 * when the server copies it into an event the player has earned — a completed
 * investigation, or an incident that has actually fired.
 *
 * The fixed truth: at 07:42 a stolen administrator credential produced a valid
 * session; at 07:49 the attacker changed the authentication configuration and
 * read token-signing material; at 07:53 an unrelated deployment went out; at
 * 08:00 sign-in failures spiked. The deployment is a decoy. Health can be
 * patched without resolving anything: the incident is over only when the
 * admin session is revoked AND the signing keys are rotated.
 */

import { facts, type ActionId, type IncidentId, type SimulationState } from '../../game/engine.js'

/**
 * What an action reveals when it completes. `state` is the state just BEFORE
 * the completion is applied, so conditional findings describe what was true
 * while the work was being done.
 */
export function actionFinding(actionId: ActionId, state: SimulationState): string {
  const f = facts(state)
  switch (actionId) {
    case 'inspect_access_logs':
      return 'Access logs show an admin console sign-in at 07:42 from a device never seen on this account.'
    case 'correlate_session_events':
      return 'The 07:42 admin session is still live and is not the account owner: at 07:49 it changed the authentication configuration. This is a compromised session, not an outage.'
    case 'investigate_signing_access':
      return 'At 07:49 the same session read the token-signing keys. Anyone holding them can mint valid tokens, with or without that session.'
    case 'revoke_admin_sessions':
      return 'All administrator sessions are revoked and the stolen credential is disabled. The intruder no longer has console access.'
    case 'validate_containment':
      return f.keysRotated
        ? 'No administrator sessions remain and the signing keys in use were issued after the intrusion. Containment holds.'
        : 'No administrator sessions remain, but tokens signed with the pre-incident keys are still being accepted. The keys the intruder read are still valid.'
    case 'review_deployment':
      return 'The 07:53 deployment changed a billing export job only. It touches nothing in authentication and went out after the first anomaly. It is not the cause.'
    case 'roll_back_release':
      return state.rollbackAfterDiagnosis
        ? 'The 07:53 release is rolled back. Error rates ease slightly, but the cause was already known to be a compromised session; customers saw a visible change that fixed nothing.'
        : 'The 07:53 release is rolled back. Error rates ease slightly, but sign-in failures continue. The release was not the root cause.'
    case 'rotate_signing_keys':
      return 'New signing keys are live and the exposed keys are rejected. Every existing customer session has been signed out.'
    case 'restore_auth':
      return 'The authentication configuration is restored to its last known-good state. Sign-ins are succeeding again.'
    case 'validate_recovery':
      return 'Synthetic sign-ins pass in every region and the error rate is back to baseline. Recovery is verified.'
    case 'issue_customer_advisory':
      return 'A customer advisory is published: sign-in is disrupted, the cause is under investigation, and the next update is promised within the hour.'
    case 'confirm_resolution':
      return 'The Incident Commander declares the incident resolved.'
  }
}

/** What the team is told when a scheduled incident fires, by branch. */
export function incidentReport(incidentId: IncidentId, applied: boolean): string {
  switch (incidentId) {
    case 'initial_alert':
      return '08:00 — Sign-in failures are spiking across Meridian Cloud. A deployment went out at 07:53. Cause unknown.'
    case 'service_degradation':
      return applied
        ? 'Sign-in failures are spreading to more regions. Support tickets are climbing.'
        : 'Sign-in success rates are holding steady.'
    case 'attacker_activity':
      return applied
        ? 'Warning: new privileged activity observed on the admin plane. Something still has access.'
        : 'No further privileged activity observed.'
    case 'outage_spreads':
      return applied
        ? 'The outage is now customer-wide. Large accounts are escalating directly to executives.'
        : 'Service levels remain normal.'
    case 'attacker_escalation':
      return applied
        ? 'A live administrator session has just read the token-signing keys again. The signing material must be treated as exposed.'
        : 'No administrator sessions are active. No further access to signing material.'
    case 'token_replay':
      return applied
        ? 'Tokens signed with the pre-incident keys are being replayed against customer APIs. Customers are noticing.'
        : 'Tokens signed with the old keys are being rejected. No replay is possible.'
    case 'communication_gap':
      return applied
        ? 'Customers have heard nothing from Meridian Cloud for five and a half minutes. Speculation is spreading publicly.'
        : 'Customers have been kept informed.'
    case 'deadline_warning':
      return 'One minute until the executive bridge call. Whatever state the incident is in then is what gets reported.'
    case 'finalization':
      return 'Time is up. The incident is assessed as it stands.'
  }
}
