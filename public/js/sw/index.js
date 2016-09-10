self.addEventListener('fetch', function(event) {
   // tell browser we will handle this event ouselves.
   // event.respondWith takes a repsonse object or a promise that resolve with a repsonse
   event.respondWith(
       // can take blob, buffer string or other data
       new Response('Hello World!')
   );
});
