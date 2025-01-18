const functions = require('firebase-functions');
const admin = require('firebase-admin');
const OpenAI = require('openai');

admin.initializeApp();
const db = admin.firestore();

const openai = new OpenAI({
  apiKey: functions.config().openai.key
});

exports.extractTextFromImage = functions
  .region('us-central1')
  .runWith({
    timeoutSeconds: 300,
    memory: '1GB'
  })
  .https.onCall(async (data, context) => {
    try {
      const { imageBase64 } = data;

      if (!imageBase64) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'The function must be called with imageBase64.'
        );
      }

      const base64Image = imageBase64.replace(/^data:image\/\w+;base64,/, '');

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are a text extraction tool. Your only job is to read and return the exact text from images. Do not add any explanations, descriptions, or additional context. Just return the text exactly as it appears in the image."
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract and return only the text from this image, exactly as it appears." },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 1000,
      });

      return {
        success: true,
        text: response.choices[0].message.content,
      };
    } catch (error) {
      console.error('Error:', error);
      throw new functions.https.HttpsError('internal', error.message);
    }
  });


exports.processChat = functions
  .region('us-central1')
  .runWith({
    timeoutSeconds: 300,
    memory: '1GB'
  })
  .https.onCall(async (data, context) => {
    const maxNumberOfMessages = 20;

    // Ensure user is authenticated
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'The function must be called while authenticated.'
      );
    }

    const userId = context.auth.uid;
    const userMessage = data.message;

    if (!userMessage) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'The function must be called with a message.'
      );
    }

    try {
      // Reference to user's chat collection
      const chatRef = db.collection('chatbot').doc(userId);
      const messagesRef = chatRef.collection('messages');

      // Add user message
      const userMessageDoc = await messagesRef.add({
        content: userMessage,
        isUser: true,
        timestamp: admin.firestore.Timestamp.now(),
        status: 'delivered'
      });

      // Add placeholder for AI response
      const aiMessageDoc = await messagesRef.add({
        content: '',
        isUser: false,
        timestamp: admin.firestore.Timestamp.now(),
        status: 'processing'
      });

      // Get last 20 messages for context
      const lastMessages = await messagesRef
        .orderBy('timestamp', 'desc')
        .limit(maxNumberOfMessages)
        .get();

      // Format messages for OpenAI
      const messages = lastMessages.docs
        .map(doc => doc.data())
        .reverse()
        .map(msg => ({
          role: msg.isUser ? 'user' : 'assistant',
          content: msg.content
        }));

      // Add system message for context
      messages.unshift({
        role: 'system',
        content: 'You are Atomic, an AI chemistry teacher. You help students understand chemistry concepts. Keep your answers focused on chemistry and educational. Your responses should be clear and suitable for students.'
      });

      // Get response from OpenAI
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',  
        messages: messages,
        temperature: 0.7,
        max_tokens: 500
      });

      const aiResponse = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';

      // Update AI message in Firestore
      await aiMessageDoc.update({
        content: aiResponse,
        status: 'completed',
        timestamp: admin.firestore.Timestamp.now()
      });

      // Update metadata
      await chatRef.set({
        last_interaction: admin.firestore.Timestamp.now(),
        total_messages: admin.firestore.FieldValue.increment(2)
      }, { merge: true });

      return {
        success: true,
        messageId: aiMessageDoc.id
      };

    } catch (error) {
      console.error('Error processing chat:', error);

      // Update AI message with error status if it exists
      if (aiMessageDoc) {
        await aiMessageDoc.update({
          status: 'error',
          content: 'Sorry, an error occurred while processing your message.'
        });
      }

      throw new functions.https.HttpsError('internal', error.message);
    }
  });