import { eveChannel } from 'eve/channels/eve'
import { spikeAuth } from '../lib/spike-auth'

/** The HTTP channel, for the eval's photo turns and tooling. */
export default eveChannel({ auth: [spikeAuth] })
