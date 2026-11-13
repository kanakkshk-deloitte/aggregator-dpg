<#import "template.ftl" as layout>
<@layout.emailLayout>
${kcSanitize(msg("emailOtpBodyHtml", code, msg("emailOtpSignoff")))?no_esc}
</@layout.emailLayout>
