/** Thrown inside hqRepo.transitionTask when a standup may not be requeued (the service maps it to 409). */
export class StandupRequeueRefused extends Error {
  constructor() {
    super("Use 'Start standup now' for today's standup");
    this.name = 'StandupRequeueRefused';
  }
}
