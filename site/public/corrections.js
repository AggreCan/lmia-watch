/* The corrections form opened from a profile: the link is /corrections#<id>,
   one URL for every profile, and this copies the employer id from the
   fragment into the form's hidden employer field. A field the page already
   filled (from ?employer= or a form sent back with an error) is kept. The id
   shape is the site's EMPLOYER_ID_RE (src/data.ts). Without this script the
   form still works: the server matches the record reference the reader types. */
(function () {
  var EMPLOYER_ID_RE = /^emp-[0-9a-f]{10}$/;
  var field = document.querySelector('form[action="/corrections"] input[name="employer"]');
  if (!field || field.value) return;
  var id = location.hash.slice(1);
  if (EMPLOYER_ID_RE.test(id)) field.value = id;
})();
