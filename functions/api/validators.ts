import { handleValidatorsRequest } from "../../src/server/validators"

export const onRequestGet: PagesFunction = async ({ request }) => handleValidatorsRequest(request)

export const onRequestPost: PagesFunction = async ({ request }) => handleValidatorsRequest(request)
