import { handleRewardProofRequest } from "../../../src/server/rewardsProof"

export const onRequestGet: PagesFunction = async ({ request }) => handleRewardProofRequest(request)

export const onRequestPost: PagesFunction = async ({ request }) => handleRewardProofRequest(request)
