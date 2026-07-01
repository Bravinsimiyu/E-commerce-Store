import { stripe } from "../lib/stripe.js";
import Coupon from "../models/coupon.model.js"
import Order from "../models/order.model.js"

export const createCheckoutSession = async (req, res) => {
  try {
    const { products, couponCode } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        error: "Invalid or empty products array",
      });
    }

    let totalAmount = 0;

    const lineItems = products.map((product) => {
      const amount = Math.round(product.price * 100);

      totalAmount += amount * product.quantity;

      return {
        price_data: {
          currency: "usd",
          product_data: {
            name: product.name,
            images: [product.image],
          },
          unit_amount: amount,
        },
        quantity: product.quantity || 1,
      };
    });

    let coupon = null;

    if (couponCode) {
      coupon = await Coupon.findOne({
        code: couponCode,
        userId: req.user._id,
        isActive: true,
      });

      if (coupon) {
        totalAmount -= Math.round((totalAmount * coupon.discountPercentage) / 100);
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",

      success_url: `${process.env.CLIENT_URL}/purchase-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/purchase-cancel`,

      discounts: coupon
        ? [
            {
              coupon: await createStripeCoupon(
                coupon.discountPercentage
              ),
            },
          ]
        : [],

      metadata: {
        userId: req.user._id.toString(),
        couponCode: couponCode || "",
        products: JSON.stringify(
          products.map((p) => ({
            id: p._id,
            quantity: p.quantity,
            price: p.price,
          }))
        ),
      },
    });

    if (totalAmount >= 20000) {
      await createNewCoupon(req.user._id);
    }

    res.status(200).json({
      url: session.url,
      sessionId: session.id,
      totalAmount: totalAmount / 100,
    });
  } catch (error) {
    console.error("Error processing checkout:", error);

    res.status(500).json({
      message: "Error processing checkout",
      error: error.message,
    });
  }
};

export const checkoutSuccess = async (req, res) => {
	try {
		const { sessionId } = req.body;

		if (!sessionId) {
			return res.status(400).json({
				message: "Session ID is required",
			});
		}

		const session = await stripe.checkout.sessions.retrieve(
			sessionId
		);

		if (session.payment_status !== "paid") {
			return res.status(400).json({
				message: "Payment not completed",
			});
		}

		// prevent duplicate orders
		const existingOrder = await Order.findOne({
			stripeSessionId: sessionId,
		});

		if (existingOrder) {
			return res.status(200).json({
				success: true,
				message: "Order already exists",
				orderId: existingOrder._id,
			});
		}

		// deactivate coupon if used
		if (session.metadata.couponCode) {
			await Coupon.findOneAndUpdate(
				{
					code: session.metadata.couponCode,
					userId: session.metadata.userId,
				},
				{ isActive: false }
			);
		}

		const products = JSON.parse(
			session.metadata.products || "[]"
		);

		const newOrder = new Order({
			user: session.metadata.userId,
			products: products.map((product) => ({
				product: product.id,
				quantity: product.quantity,
				price: product.price,
			})),
			totalAmount: session.amount_total / 100,
			stripeSessionId: sessionId,
		});

		await newOrder.save();

		res.status(200).json({
			success: true,
			message:
				"Payment successful, order created successfully.",
			orderId: newOrder._id,
		});
	} catch (error) {
		console.error("Error processing successful checkout:", error);

		res.status(500).json({
			message: "Error processing successful checkout",
			error: error.message,
		});
	}
};

const stripeCouponCache = new Map();

async function createStripeCoupon(discountPercentage) {
	try {
		if (!discountPercentage || discountPercentage <= 0) {
			throw new Error("Invalid discount percentage");
		}

		// reuse existing Stripe coupon instead of creating duplicates
		if (stripeCouponCache.has(discountPercentage)) {
			return stripeCouponCache.get(discountPercentage);
		}

		const coupon = await stripe.coupons.create({
			percent_off: discountPercentage,
			duration: "once",
		});

		stripeCouponCache.set(discountPercentage, coupon.id);

		return coupon.id;
	} catch (error) {
		console.error("Error creating Stripe coupon:", error);
		throw error;
	}
}

async function createNewCoupon(userId) {
	try {
		await Coupon.findOneAndDelete({ userId });
		const discountPercentage = 10;

		const generateCode = () => {
			const random = Math.random()
				.toString(36)
				.substring(2, 8)
				.toUpperCase();

			const timestamp = Date.now().toString(36).toUpperCase();

			return `GIFT-${random}-${timestamp}`;
		};

		let newCoupon = new Coupon({
			code: generateCode(),
			discountPercentage,
			expirationDate: new Date(
				Date.now() + 30 * 24 * 60 * 60 * 1000
			),
			userId,
			isActive: true,
		});

		// CHECK FOR DUPLICATE CODE HERE
		const existing = await Coupon.findOne({
			code: newCoupon.code,
		});

		if (existing) {
			return createNewCoupon(userId); // regenerate safely
		}

		await newCoupon.save();

		return newCoupon;
	} catch (error) {
		console.error("Error creating new coupon:", error);
		throw error;
	}
}