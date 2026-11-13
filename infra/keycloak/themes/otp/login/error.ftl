<#import "template.ftl" as layout>
<#--
  Overrides keycloak.v2's error page for one reason: to give the visitor a way
  out.

  The portal entitlement gate (infra/keycloak/init/apply-portal-gate.py) denies
  on the auth-cookie path too, so someone signed in to the other DPG in the
  same browser is refused here without a token ever being issued. The base page
  offers only "back to application", which re-enters SSO, hands the same
  identity to the same gate and lands straight back on this page — refreshing
  cannot help, because the realm session is what is being replayed.

  The realm is shared by both DPGs, so ending it is the only thing that lets
  the visitor name a different account. `id_token_hint` is not available on an
  error page, so Keycloak will ask for confirmation before signing out; that
  prompt is honest here, since signing out also ends the other app's session.

  `post_logout_redirect_uri` is deliberately NOT sent: it is validated against
  the client's registered URIs, and an unregistered value fails with "Invalid
  redirect uri" — swapping one dead end for another. Passing `client_id` alone
  is enough for Keycloak to offer its own link back to the application after
  sign-out.
-->
<@layout.registrationLayout displayMessage=false; section>
<!-- template: error.ftl -->

    <#if section="header">
        ${msg("errorTitle")}
    <#elseif section="form">
        <div id="kc-error-message" class="bd-form-area">
            <p class="instruction">${kcSanitize(message.summary)?no_esc}</p>

            <#--
              `url.resourcesPath` is the only reliable handle on the server's
              base path from an error page — it is "<base>/resources/<ver>/login/<theme>",
              so trimming at "/resources/" yields the base ("" or e.g. "/auth")
              without hardcoding either.
            -->
            <#assign kcBase = url.resourcesPath?keep_before("/resources/")>
            <#assign logoutUrl = kcBase + "/realms/" + realm.name?url('UTF-8') + "/protocol/openid-connect/logout">
            <#if client?? && client.clientId?has_content>
                <#assign logoutUrl = logoutUrl + "?client_id=" + client.clientId?url('UTF-8')>
            </#if>

            <p class="bd-error-switch">
                <span>${msg("errorWrongAccountPrompt")}</span>
                <a id="signOutAndSwitch" class="bd-link-btn" href="${logoutUrl}">
                    ${msg("doSignOutAndSwitch")}
                </a>
            </p>

            <#if skipLink??>
            <#else>
                <#if client?? && client.baseUrl?has_content>
                    <p>
                        <a id="backToApplication" href="${client.baseUrl}">
                            ${kcSanitize(msg("backToApplication"))?no_esc}
                        </a>
                    </p>
                </#if>
            </#if>
        </div>
    </#if>
</@layout.registrationLayout>
